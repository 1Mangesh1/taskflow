import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
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

const commentsUrl = (orgId: string, projectId: string, taskId: string, suffix = '') =>
  `/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}/comments${suffix}`;

async function setup() {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  await addMember(app, acme.id, alice.id, ben.email);
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  const task = await createTask(app, acme.id, project.id, alice.id, 'Draft the new nav');

  return { alice, ben, acme, project, task };
}

const comment = (
  ids: { acme: { id: string }; project: { id: string }; task: { id: string } },
  userId: string,
  body: string,
) =>
  app.inject({
    method: 'POST',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id),
    headers: asUser(app, userId),
    body: { body },
  });

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('a comment is written, read back on the thread, and counted on the task', async () => {
  const ids = await setup();

  const created = await comment(ids, ids.alice.id, 'The nav should stay two levels deep');

  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({
    id: expect.any(String),
    body: 'The nav should stay two levels deep',
    author: { id: ids.alice.id, name: 'Alice Navarro' },
    createdAt: expect.any(String),
  });

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${ids.acme.id}/projects/${ids.project.id}/tasks/${ids.task.id}`,
    headers: asUser(app, ids.alice.id),
  });
  expect(detail.json().commentCount).toBe(1);
});

test('a thread reads oldest first and pages through the shared helper', async () => {
  const ids = await setup();
  for (const body of ['First thought', 'Second thought', 'Third thought']) {
    await comment(ids, ids.ben.id, body);
  }

  const page = await app.inject({
    method: 'GET',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id, '?page=2&limit=2'),
    headers: asUser(app, ids.alice.id),
  });

  expect(page.statusCode).toBe(200);
  expect(page.json()).toEqual({
    data: [
      {
        id: expect.any(String),
        body: 'Third thought',
        author: { id: ids.ben.id, name: 'Ben Okafor' },
        createdAt: expect.any(String),
      },
    ],
    total: 3,
    page: 2,
    limit: 2,
  });
});

test('a comment body is required and cannot run past 2000 characters', async () => {
  const ids = await setup();

  expect((await comment(ids, ids.alice.id, '   ')).statusCode).toBe(400);
  expect((await comment(ids, ids.alice.id, 'x'.repeat(2001))).statusCode).toBe(400);
  expect((await comment(ids, ids.alice.id, 'x'.repeat(2000))).statusCode).toBe(201);
});

test('only the author may delete a comment', async () => {
  const ids = await setup();
  const written = await comment(ids, ids.ben.id, 'I will take this one');
  const { id } = written.json<{ id: string }>();

  const byOther = await app.inject({
    method: 'DELETE',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id, `/${id}`),
    headers: asUser(app, ids.alice.id),
  });
  expect(byOther.statusCode).toBe(403);
  expect(byOther.json().code).toBe('FORBIDDEN');

  const byAuthor = await app.inject({
    method: 'DELETE',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id, `/${id}`),
    headers: asUser(app, ids.ben.id),
  });
  expect(byAuthor.statusCode).toBe(204);

  const list = await app.inject({
    method: 'GET',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id),
    headers: asUser(app, ids.ben.id),
  });
  expect(list.json()).toMatchObject({ data: [], total: 0 });
});

test('deleting a comment that is not there says so', async () => {
  const ids = await setup();

  const res = await app.inject({
    method: 'DELETE',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id, `/${randomUUID()}`),
    headers: asUser(app, ids.alice.id),
  });

  expect(res.statusCode).toBe(404);
  expect(res.json().code).toBe('COMMENT_NOT_FOUND');
});

// The comment routes hang off a task, so they inherit its visibility: a deleted task has
// no thread to read or write.
test('a soft-deleted task has no comment thread', async () => {
  const ids = await setup();
  await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${ids.acme.id}/projects/${ids.project.id}/tasks/${ids.task.id}`,
    headers: asUser(app, ids.alice.id),
  });

  const written = await comment(ids, ids.alice.id, 'Anyone still on this?');
  expect(written.statusCode).toBe(404);
  expect(written.json().code).toBe('TASK_NOT_FOUND');

  const list = await app.inject({
    method: 'GET',
    url: commentsUrl(ids.acme.id, ids.project.id, ids.task.id),
    headers: asUser(app, ids.alice.id),
  });
  expect(list.statusCode).toBe(404);
});
