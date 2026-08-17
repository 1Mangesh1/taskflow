import { pathToFileURL } from 'node:url';
import { Worker } from 'bullmq';
import { type AssignmentEmail, closeQueue, connection, emailDlq } from './lib/queue.js';

// Test seam: the one payload the worker fails on demand, so the retry and dead-letter
// paths can be exercised end to end. .invalid is reserved by RFC 2606, so no assignee
// can hold this address and no other payload changes what the worker does.
export const BOUNCE_SENTINEL = 'bounce@taskflow.invalid';

export const emailWorker = new Worker<AssignmentEmail>(
  'email',
  async (job) => {
    const { assigneeEmail, taskId, taskTitle, assignerName } = job.data;
    // Nothing here catches: BullMQ is what retries the job on the producer's backoff,
    // and a processor that swallowed its own failure would report a notification that
    // never went out as delivered.
    if (assigneeEmail === BOUNCE_SENTINEL) {
      throw new Error(`mailbox unavailable: ${assigneeEmail}`);
    }

    // Mock delivery: one structured line naming the recipient and the task.
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'email sent',
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        to: assigneeEmail,
        taskId,
        taskTitle,
        assignedBy: assignerName,
      }),
    );
  },
  {
    connection,
    // 50 emails a minute, whatever the queue depth. The counter is a Redis key rather
    // than process state, so a second worker shares the same budget instead of doubling
    // what the mail provider sees.
    limiter: { max: 50, duration: 60_000 },
  },
);

// Same reason as the connection listener in lib/queue.ts: BullMQ surfaces connection
// trouble as an 'error' event, and an unheard one ends the process.
emailWorker.on('error', (err) =>
  console.error(JSON.stringify({ level: 'error', msg: 'worker error', error: err.message })),
);

// attemptsMade is already incremented when this fires, so it only reaches the job's
// ceiling on the last attempt: every earlier failure is on its way back to the queue
// and dead-lettering it there would file a job that is still going to be delivered.
emailWorker.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;

  try {
    await emailDlq.add(job.name, { ...job.data, failedReason: err.message });
  } catch (dlqErr) {
    // The dead letter is the last record of the job, so losing it is worth a line of
    // its own rather than an unhandled rejection from an event listener.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'dead letter failed',
        jobId: job.id,
        error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
      }),
    );
  }
});

// A container stop is a signal, not a call to close(): the worker goes first so a job
// in flight is finished rather than left for the stalled checker to find, then the
// connection it shares with the queues.
//
// Only when this file is the process entrypoint. Imported instead (RUN_WORKER, tests),
// a second set of handlers would race the importer's own shutdown over the shared
// connection, and closing it from under an unfinished chain hangs the exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = () =>
    emailWorker
      .close()
      .then(closeQueue)
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
