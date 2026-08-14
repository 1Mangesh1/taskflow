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

const assigneesUrl = (orgId: string, projectId: string, taskId: string) =>
  `/api/orgs/${orgId}/projects/${projectId}/tasks/${taskId}/assignees`;

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

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('an assignment names the assigner from the token and shows up on the task', async () => {
  const { alice, ben, acme, project, task } = await setup();

  const created = await app.inject({
    method: 'POST',
    url: assigneesUrl(acme.id, project.id, task.id),
    headers: asUser(app, alice.id),
    body: { userId: ben.id },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({
    taskId: task.id,
    userId: ben.id,
    assignedBy: alice.id,
    createdAt: expect.any(String),
    jobId: expect.any(String),
  });

  const detail = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects/${project.id}/tasks/${task.id}`,
    headers: asUser(app, alice.id),
  });
  expect(detail.json().assignees).toEqual([
    { userId: ben.id, email: 'ben.okafor@acme-corp.example', name: 'Ben Okafor' },
  ]);
});

test('a user who is not a member of the organization is refused', async () => {
  const { alice, dan, acme, project, task } = await setup();

  const res = await app.inject({
    method: 'POST',
    url: assigneesUrl(acme.id, project.id, task.id),
    headers: asUser(app, alice.id),
    body: { userId: dan.id },
  });

  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({
    error: expect.any(String),
    code: 'USER_NOT_ORG_MEMBER',
    details: {},
  });
});

test('assigning on a task that does not exist is a task 404, not an assignment error', async () => {
  const { alice, ben, acme, project } = await setup();

  const res = await app.inject({
    method: 'POST',
    url: assigneesUrl(acme.id, project.id, randomUUID()),
    headers: asUser(app, alice.id),
    body: { userId: ben.id },
  });

  expect(res.statusCode).toBe(404);
  expect(res.json().code).toBe('TASK_NOT_FOUND');
});

test('unassigning answers 204, and answers 404 once there is nothing left to unassign', async () => {
  const { alice, ben, acme, project, task } = await setup();
  await app.inject({
    method: 'POST',
    url: assigneesUrl(acme.id, project.id, task.id),
    headers: asUser(app, alice.id),
    body: { userId: ben.id },
  });

  const removed = await app.inject({
    method: 'DELETE',
    url: `${assigneesUrl(acme.id, project.id, task.id)}/${ben.id}`,
    headers: asUser(app, alice.id),
  });
  expect(removed.statusCode).toBe(204);

  const again = await app.inject({
    method: 'DELETE',
    url: `${assigneesUrl(acme.id, project.id, task.id)}/${ben.id}`,
    headers: asUser(app, alice.id),
  });
  expect(again.statusCode).toBe(404);
  expect(again.json().code).toBe('ASSIGNMENT_NOT_FOUND');
});

test('a member of another organization cannot reach the assignment routes at all', async () => {
  const { ben, dan, acme, project, task } = await setup();

  const res = await app.inject({
    method: 'POST',
    url: assigneesUrl(acme.id, project.id, task.id),
    headers: asUser(app, dan.id),
    body: { userId: ben.id },
  });

  expect(res.statusCode).toBe(403);
  expect(res.json().code).toBe('FORBIDDEN');
});
