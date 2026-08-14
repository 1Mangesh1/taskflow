import type { JobState } from 'bullmq';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JobNotFoundError } from '../../lib/errors.js';
import { emailQueue } from '../../lib/queue.js';

// The four statuses the API contract exposes. Every way BullMQ has of saying "not
// started yet" is one of them from the caller's side, so they all collapse to pending.
const statusOf: Record<JobState, 'pending' | 'active' | 'completed' | 'failed'> = {
  waiting: 'pending',
  delayed: 'pending',
  prioritized: 'pending',
  'waiting-children': 'pending',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
};

export const toJobStatus = (state: JobState) => statusOf[state];

export async function get(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const job = await emailQueue.getJob(request.params.id);
  if (!job) throw new JobNotFoundError();

  const state = await job.getState();
  // The job was removed between the two reads, which is the same answer as never
  // having existed.
  if (state === 'unknown') throw new JobNotFoundError();

  return reply.send({
    id: request.params.id,
    name: job.name,
    status: toJobStatus(state),
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
  });
}
