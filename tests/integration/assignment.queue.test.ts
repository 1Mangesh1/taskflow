import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { emailQueue } from '../../src/lib/queue.js';
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

// The real queue, against the Redis database index tests/setup.ts points the app at.
// Nothing is mocked here: the point of these tests is that assigning really does put a
// job on the queue a worker would read.
const waiting = () => emailQueue.getJobs(['waiting']);

async function setup() {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  await addMember(app, acme.id, alice.id, ben.email);
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  const task = await createTask(app, acme.id, project.id, alice.id, 'Draft the new nav');

  return { alice, ben, dan, acme, project, task };
}

const assign = (
  ids: { acme: { id: string }; project: { id: string }; task: { id: string } },
  assignerId: string,
  userId: string,
) =>
  app.inject({
    method: 'POST',
    url: `/api/orgs/${ids.acme.id}/projects/${ids.project.id}/tasks/${ids.task.id}/assignees`,
    headers: asUser(app, assignerId),
    body: { userId },
  });

const unassign = (
  ids: { acme: { id: string }; project: { id: string }; task: { id: string } },
  assignerId: string,
  userId: string,
) =>
  app.inject({
    method: 'DELETE',
    url: `/api/orgs/${ids.acme.id}/projects/${ids.project.id}/tasks/${ids.task.id}/assignees/${userId}`,
    headers: asUser(app, assignerId),
  });

beforeEach(async () => {
  await truncateAll();
  await emailQueue.obliterate({ force: true });
  app = await buildTestApp();
});

afterEach(() => app.close());

test('assigning a user puts one task-assigned job on the email queue', async () => {
  const ids = await setup();

  const res = await assign(ids, ids.alice.id, ids.ben.id);
  expect(res.statusCode).toBe(201);

  const jobs = await waiting();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.name).toBe('task-assigned');
  expect(jobs[0]?.id).toBe(res.json().jobId);
  expect(jobs[0]?.data).toEqual({
    taskId: ids.task.id,
    taskTitle: 'Draft the new nav',
    assigneeId: ids.ben.id,
    assigneeEmail: 'ben.okafor@acme-corp.example',
    assignerId: ids.alice.id,
    assignerName: 'Alice Navarro',
    orgId: ids.acme.id,
  });
});

// 3 attempts with an exponential backoff of 1000 ms is 1s, 2s, 4s between retries.
test('the job carries the retry policy the worker will be held to', async () => {
  const ids = await setup();
  await assign(ids, ids.alice.id, ids.ben.id);

  const [job] = await waiting();
  expect(job?.opts.attempts).toBe(3);
  expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
});

test('unassigning enqueues nothing', async () => {
  const ids = await setup();
  await assign(ids, ids.alice.id, ids.ben.id);

  const removed = await unassign(ids, ids.alice.id, ids.ben.id);

  expect(removed.statusCode).toBe(204);
  expect(await waiting()).toHaveLength(1);
});

// Assigning twice in a row is refused by the database, so the pair only comes back
// round within the deduplication window by way of an unassign.
test('re-assigning the same pair within the dedup window is still one notification', async () => {
  const ids = await setup();
  const first = await assign(ids, ids.alice.id, ids.ben.id);
  await unassign(ids, ids.alice.id, ids.ben.id);

  const second = await assign(ids, ids.alice.id, ids.ben.id);

  expect(second.statusCode).toBe(201);
  expect(second.json().jobId).toBe(first.json().jobId);
  expect(await waiting()).toHaveLength(1);
});

test('a refused assignment enqueues nothing', async () => {
  const ids = await setup();

  const res = await assign(ids, ids.alice.id, ids.dan.id);

  expect(res.statusCode).toBe(400);
  expect(res.json().code).toBe('USER_NOT_ORG_MEMBER');
  expect(await waiting()).toHaveLength(0);
});

test('the job status endpoint answers pending while no worker has picked the job up', async () => {
  const ids = await setup();
  const { jobId } = (await assign(ids, ids.alice.id, ids.ben.id)).json<{ jobId: string }>();

  const res = await app.inject({
    method: 'GET',
    url: `/api/jobs/${jobId}`,
    headers: asUser(app, ids.alice.id),
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    id: jobId,
    name: 'task-assigned',
    status: 'pending',
    attemptsMade: 0,
  });
});

test('an unknown job id is a 404, and an anonymous caller never gets that far', async () => {
  const { alice } = await setup();

  const missing = await app.inject({
    method: 'GET',
    url: '/api/jobs/424242',
    headers: asUser(app, alice.id),
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().code).toBe('JOB_NOT_FOUND');

  const anonymous = await app.inject({ method: 'GET', url: '/api/jobs/424242' });
  expect(anonymous.statusCode).toBe(401);
});
