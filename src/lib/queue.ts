import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

// Everything the worker needs to send the mail: a job never reads the database, so a
// task renamed or a member removed after the assignment cannot change the notification.
export type AssignmentEmail = {
  taskId: string;
  taskTitle: string;
  assigneeId: string;
  assigneeEmail: string;
  assignerId: string;
  assignerName: string;
  orgId: string;
};

// null rather than ioredis' default of 20: BullMQ requires it, because a blocking
// command that gives up mid-call would lose the job it was holding. The offline queue
// is deliberately left on: BullMQ runs one INFO on the connection when the Queue is
// constructed and caches the result, so a client that fails commands while Redis is
// down never finishes that handshake and stays broken after Redis comes back.
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const emailQueue = new Queue<AssignmentEmail>('email', { connection });

// An add issued while Redis is down is buffered rather than rejected, so the wait is
// bounded here and the caller is told the enqueue did not happen. The buffered job
// still lands whenever Redis comes back, which is a late notification rather than a
// lost one.
// ponytail: a buffered add that fails minutes later goes unlogged; a queue error
// listener is the upgrade if that ever has to be visible.
const ENQUEUE_TIMEOUT_MS = 1000;

export function enqueueAssignmentEmail(email: AssignmentEmail) {
  const queued = emailQueue
    .add('task-assigned', email, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      // Finished jobs are kept rather than removed on completion: GET /api/jobs/:id can
      // only answer for a job that is still in Redis. An hour of completions and a day
      // of failures covers polling and post-mortems without growing the sets forever.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600 },
      // Re-assigning the same user to the same task in quick succession is one
      // notification, not two.
      deduplication: { id: `${email.taskId}:${email.assigneeId}`, ttl: 5000 },
    })
    .then((job) => job.id ?? null);

  return Promise.race([
    queued,
    delay(ENQUEUE_TIMEOUT_MS, null, { ref: false }).then(() => {
      throw new Error(`task-assigned enqueue timed out after ${ENQUEUE_TIMEOUT_MS} ms`);
    }),
  ]);
}

// The queue does not own the connection it was handed, so closing it is not enough:
// both have to go for the process to be able to exit.
export async function closeQueue() {
  await emailQueue.close();
  await connection.quit();
}
