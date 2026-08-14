import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { emailDlq, emailQueue } from '../../src/lib/queue.js';
import { BOUNCE_SENTINEL, emailWorker } from '../../src/worker.js';
import {
  addMember,
  asUser,
  buildTestApp,
  createOrg,
  createProject,
  createTask,
} from '../helpers/app.js';
import { createUser, truncateAll } from '../helpers/db.js';

let app: FastifyInstance;

// The real worker against the Redis database index tests/setup.ts points the app at.
// A job keeps one processedOn, not one per attempt, so the only record of when each
// attempt failed is the event as it happens. Only the retry test ever fails a job.
const failedAt: number[] = [];
emailWorker.on('failed', () => failedAt.push(Date.now()));

async function setup() {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const bounce = await createUser(BOUNCE_SENTINEL, 'Bounce Sentinel');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  await addMember(app, acme.id, alice.id, ben.email);
  await addMember(app, acme.id, alice.id, bounce.email);
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  const task = await createTask(app, acme.id, project.id, alice.id, 'Draft the new nav');

  return { alice, ben, bounce, acme, project, task };
}

const assign = (
  ids: { acme: { id: string }; project: { id: string }; task: { id: string } },
  assignerId: string,
  userId: string,
) =>
  app
    .inject({
      method: 'POST',
      url: `/api/orgs/${ids.acme.id}/projects/${ids.project.id}/tasks/${ids.task.id}/assignees`,
      headers: asUser(app, assignerId),
      body: { userId },
    })
    .then((res) => res.json<{ jobId: string }>());

const jobStatus = (jobId: string, userId: string) =>
  app
    .inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: asUser(app, userId) })
    .then((res) =>
      res.json<{
        id: string;
        name: string;
        status: string;
        attemptsMade: number;
        failedReason?: string;
      }>(),
    );

// The worker runs in this process but on its own schedule, so every assertion about
// what it did has to wait for it. Returning the last value read on timeout leaves the
// failure to the assertion that follows, which says what was expected.
async function until<T>(read: () => Promise<T>, settled: (value: T) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (settled(value) || Date.now() > deadline) return value;
    await delay(25);
  }
}

beforeEach(async () => {
  await truncateAll();
  await emailQueue.obliterate({ force: true });
  await emailDlq.obliterate({ force: true });
  failedAt.length = 0;
  app = await buildTestApp();
});

afterEach(() => app.close());

test('a queued job is delivered and the status endpoint then reports it completed', async () => {
  const ids = await setup();
  const { jobId } = await assign(ids, ids.alice.id, ids.ben.id);

  await until(
    () => jobStatus(jobId, ids.alice.id),
    (job) => job.status === 'completed',
  );

  // Read again rather than asserting on the poll that first saw completed: the endpoint
  // reads the job and its state in two round trips, so a poll landing between them
  // pairs the settled state with the counter as it was one attempt earlier.
  expect(await jobStatus(jobId, ids.alice.id)).toEqual({
    id: jobId,
    name: 'task-assigned',
    status: 'completed',
    attemptsMade: 1,
  });
});

test('a failing job is attempted three times on the backoff schedule, then dead-lettered', async () => {
  const ids = await setup();
  const { jobId } = await assign(ids, ids.alice.id, ids.bounce.id);

  // The first failure has two attempts still to come: nothing is dead-lettered yet.
  await until(
    async () => failedAt.length,
    (count) => count === 1,
  );
  expect(await emailDlq.getJobs(['waiting'])).toHaveLength(0);

  await until(
    () => jobStatus(jobId, ids.alice.id),
    (job) => job.status === 'failed',
  );
  const status = await jobStatus(jobId, ids.alice.id);
  expect(status.attemptsMade).toBe(3);
  expect(status.failedReason).toBe(`mailbox unavailable: ${BOUNCE_SENTINEL}`);

  const dead = await until(
    () => emailDlq.getJobs(['waiting']),
    (jobs) => jobs.length === 1,
  );
  expect(dead).toHaveLength(1);
  expect(dead[0]?.name).toBe('task-assigned');
  expect(dead[0]?.data).toEqual({
    taskId: ids.task.id,
    taskTitle: 'Draft the new nav',
    assigneeId: ids.bounce.id,
    assigneeEmail: BOUNCE_SENTINEL,
    assignerId: ids.alice.id,
    assignerName: 'Alice Navarro',
    orgId: ids.acme.id,
    failedReason: `mailbox unavailable: ${BOUNCE_SENTINEL}`,
  });

  // The producer's exponential backoff of 1000 ms is 1 s before the second attempt and
  // 2 s before the third. Tolerance is +/- 400 ms: enough for the Redis round trips and
  // BullMQ's delayed-job promotion, too little for a wrong base or a wrong factor.
  expect(failedAt).toHaveLength(3);
  expect(failedAt[1]! - failedAt[0]!).toBeGreaterThan(600);
  expect(failedAt[1]! - failedAt[0]!).toBeLessThan(1400);
  expect(failedAt[2]! - failedAt[1]!).toBeGreaterThan(1600);
  expect(failedAt[2]! - failedAt[1]!).toBeLessThan(2400);
});

// Last on purpose: the worker this file shares is closed here rather than in a hook, so
// the suite proves the shutdown path instead of relying on it to exit.
test('closing the worker stops it', async () => {
  await emailWorker.close();

  expect(emailWorker.isRunning()).toBe(false);
});
