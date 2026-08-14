import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { TaskPriority, TaskStatus } from '../../src/generated/prisma/client.js';
import { buildTestApp } from '../helpers/app.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

const NOT_FOUND = { error: expect.any(String), code: 'TASK_NOT_FOUND', details: {} };
const NO_PROJECT = { error: expect.any(String), code: 'PROJECT_NOT_FOUND', details: {} };
const FORBIDDEN = { error: expect.any(String), code: 'FORBIDDEN', details: {} };

let app: FastifyInstance;

// Tokens are signed with the app's own key rather than obtained through
// /api/auth/login: these tests are about tasks, and logging in would cost a bcrypt hash
// per user and most of the auth rate limit budget.
const asUser = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId })}` });

const createOrg = (userId: string, name: string) =>
  app
    .inject({ method: 'POST', url: '/api/orgs', headers: asUser(userId), body: { name } })
    .then((res) => res.json());

const createProject = (orgId: string, userId: string, name: string) =>
  app
    .inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/projects`,
      headers: asUser(userId),
      body: { name },
    })
    .then((res) => res.json());

const tasksUrl = (orgId: string, projectId: string, query = '') =>
  `/api/orgs/${orgId}/projects/${projectId}/tasks${query}`;

const listTasks = (orgId: string, projectId: string, userId: string, query = '') =>
  app.inject({ method: 'GET', url: tasksUrl(orgId, projectId, query), headers: asUser(userId) });

const idsOf = (res: { json: () => { data: { id: string }[] } }) =>
  res.json().data.map((task) => task.id);

// One org, three members, one project: the starting point of every test below.
async function setup() {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const carla = await createUser('carla.mendes@acme-corp.example', 'Carla Mendes');
  const acme = await createOrg(alice.id, 'Acme Corp');
  for (const user of [ben, carla]) {
    await app.inject({
      method: 'POST',
      url: `/api/orgs/${acme.id}/members`,
      headers: asUser(alice.id),
      body: { email: user.email, role: 'member' },
    });
  }
  const project = await createProject(acme.id, alice.id, 'Website Redesign');

  return { alice, ben, carla, acme, project };
}

// Written straight to the database with distinct timestamps: creating them over HTTP
// would only re-test the create route, and rows sharing a millisecond would make
// "newest first" ambiguous. Index 0 is the newest.
function seedTask(
  orgId: string,
  projectId: string,
  createdBy: string,
  index: number,
  task: { title: string; status: TaskStatus; priority: TaskPriority; dueDate: Date | null },
) {
  const newest = Date.parse('2026-05-04T09:00:00.000Z');
  return prisma.task.create({
    data: {
      ...task,
      orgId,
      projectId,
      createdBy,
      createdAt: new Date(newest - index * 1000),
    },
    select: { id: true },
  });
}

const assign = (taskId: string, userId: string, assignedBy: string) =>
  prisma.taskAssignment.create({ data: { taskId, userId, assignedBy } });

// Six tasks spanning every filter, so one fixture set answers all of them.
async function seedFilterFixtures(orgId: string, projectId: string, by: string) {
  const task = (
    index: number,
    title: string,
    status: TaskStatus,
    priority: TaskPriority,
    dueDate: string | null,
  ) =>
    seedTask(orgId, projectId, by, index, {
      title,
      status,
      priority,
      dueDate: dueDate ? new Date(dueDate) : null,
    });

  return {
    nav: await task(0, 'Draft the new nav', 'todo', 'high', '2026-05-10T12:00:00.000Z'),
    footer: await task(
      1,
      'Rebuild the footer',
      'in_progress',
      'medium',
      '2026-05-15T12:00:00.000Z',
    ),
    copy: await task(2, 'Audit the copy', 'review', 'high', '2026-05-20T12:00:00.000Z'),
    pricing: await task(3, 'Ship the pricing page', 'done', 'urgent', null),
    banner: await task(4, 'Retire the old banner', 'todo', 'low', '2026-05-01T00:00:00.000Z'),
    ci: await task(5, 'Set up CI', 'todo', 'urgent', '2026-05-31T23:59:59.999Z'),
  };
}

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('a task is created, read, listed, patched, and deleted', async () => {
  const { alice, acme, project } = await setup();

  const created = await app.inject({
    method: 'POST',
    url: tasksUrl(acme.id, project.id),
    headers: asUser(alice.id),
    body: {
      title: 'Draft the new nav',
      description: 'Three levels deep, mobile first',
      priority: 'high',
      dueDate: '2026-05-10T12:00:00.000Z',
    },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({
    id: expect.any(String),
    projectId: project.id,
    title: 'Draft the new nav',
    description: 'Three levels deep, mobile first',
    status: 'todo',
    priority: 'high',
    dueDate: '2026-05-10T12:00:00.000Z',
    createdBy: alice.id,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  const { id } = created.json();

  const read = await app.inject({
    method: 'GET',
    url: `${tasksUrl(acme.id, project.id)}/${id}`,
    headers: asUser(alice.id),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({
    id,
    title: 'Draft the new nav',
    assignees: [],
    commentCount: 0,
  });

  const listed = await listTasks(acme.id, project.id, alice.id);
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual({ data: [created.json()], total: 1, page: 1, limit: 20 });

  const patched = await app.inject({
    method: 'PATCH',
    url: `${tasksUrl(acme.id, project.id)}/${id}`,
    headers: asUser(alice.id),
    body: { status: 'in_progress', dueDate: null },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({
    id,
    title: 'Draft the new nav',
    status: 'in_progress',
    dueDate: null,
  });

  const deleted = await app.inject({
    method: 'DELETE',
    url: `${tasksUrl(acme.id, project.id)}/${id}`,
    headers: asUser(alice.id),
  });
  expect(deleted.statusCode).toBe(204);

  const gone = await app.inject({
    method: 'GET',
    url: `${tasksUrl(acme.id, project.id)}/${id}`,
    headers: asUser(alice.id),
  });
  expect(gone.statusCode).toBe(404);
  expect(gone.json()).toEqual(NOT_FOUND);
  expect((await listTasks(acme.id, project.id, alice.id)).json().total).toBe(0);
  // Soft delete keeps the row: it is a filter, not a removal.
  expect(await prisma.task.count()).toBe(1);
});

test('a task detail carries its assignees and how many comments it has', async () => {
  const { alice, ben, carla, acme, project } = await setup();
  const task = await seedTask(acme.id, project.id, alice.id, 0, {
    title: 'Draft the new nav',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });
  await assign(task.id, ben.id, alice.id);
  await assign(task.id, carla.id, alice.id);
  await prisma.comment.createMany({
    data: [
      { taskId: task.id, authorId: ben.id, body: 'Started on the desktop breakpoint' },
      { taskId: task.id, authorId: carla.id, body: 'Copy is ready when you are' },
    ],
  });

  const read = await app.inject({
    method: 'GET',
    url: `${tasksUrl(acme.id, project.id)}/${task.id}`,
    headers: asUser(alice.id),
  });

  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({
    id: task.id,
    assignees: [
      { userId: ben.id, email: ben.email, name: 'Ben Okafor' },
      { userId: carla.id, email: carla.email, name: 'Carla Mendes' },
    ],
    commentCount: 2,
  });
});

test('each filter returns exactly the tasks that match it', async () => {
  const { alice, ben, carla, acme, project } = await setup();
  const task = await seedFilterFixtures(acme.id, project.id, alice.id);
  for (const assignee of [task.nav, task.footer, task.banner]) {
    await assign(assignee.id, ben.id, alice.id);
  }
  await assign(task.pricing.id, carla.id, alice.id);

  const all = await listTasks(acme.id, project.id, alice.id);
  expect(idsOf(all)).toEqual([
    task.nav.id,
    task.footer.id,
    task.copy.id,
    task.pricing.id,
    task.banner.id,
    task.ci.id,
  ]);

  const todo = await listTasks(acme.id, project.id, alice.id, '?status=todo');
  expect(idsOf(todo)).toEqual([task.nav.id, task.banner.id, task.ci.id]);
  expect(todo.json().total).toBe(3);

  const todoOrReview = await listTasks(acme.id, project.id, alice.id, '?status=todo,review');
  expect(idsOf(todoOrReview)).toEqual([task.nav.id, task.copy.id, task.banner.id, task.ci.id]);

  const urgent = await listTasks(acme.id, project.id, alice.id, '?priority=urgent');
  expect(idsOf(urgent)).toEqual([task.pricing.id, task.ci.id]);

  const highOrLow = await listTasks(acme.id, project.id, alice.id, '?priority=high,low');
  expect(idsOf(highOrLow)).toEqual([task.nav.id, task.copy.id, task.banner.id]);

  const bens = await listTasks(acme.id, project.id, alice.id, `?assigneeId=${ben.id}`);
  expect(idsOf(bens)).toEqual([task.nav.id, task.footer.id, task.banner.id]);

  const carlas = await listTasks(acme.id, project.id, alice.id, `?assigneeId=${carla.id}`);
  expect(idsOf(carlas)).toEqual([task.pricing.id]);

  const midMay = await listTasks(
    acme.id,
    project.id,
    alice.id,
    '?dueFrom=2026-05-11T00:00:00.000Z&dueTo=2026-05-20T12:00:00.000Z',
  );
  expect(idsOf(midMay)).toEqual([task.footer.id, task.copy.id]);

  const bensTodo = await listTasks(
    acme.id,
    project.id,
    alice.id,
    `?status=todo&assigneeId=${ben.id}`,
  );
  expect(idsOf(bensTodo)).toEqual([task.nav.id, task.banner.id]);
  expect(bensTodo.json().total).toBe(2);

  const urgentTodo = await listTasks(acme.id, project.id, alice.id, '?status=todo&priority=urgent');
  expect(idsOf(urgentTodo)).toEqual([task.ci.id]);
});

test('a due-date range includes the tasks that fall exactly on either end', async () => {
  const { alice, acme, project } = await setup();
  const task = await seedFilterFixtures(acme.id, project.id, alice.id);

  // The bounds are the due dates of banner and ci themselves; the task with no due date
  // is outside any range.
  const inclusive = await listTasks(
    acme.id,
    project.id,
    alice.id,
    '?dueFrom=2026-05-01T00:00:00.000Z&dueTo=2026-05-31T23:59:59.999Z',
  );
  expect(idsOf(inclusive)).toEqual([
    task.nav.id,
    task.footer.id,
    task.copy.id,
    task.banner.id,
    task.ci.id,
  ]);

  const oneMillisecondLater = await listTasks(
    acme.id,
    project.id,
    alice.id,
    '?dueFrom=2026-05-01T00:00:00.001Z&dueTo=2026-05-31T23:59:59.998Z',
  );
  expect(idsOf(oneMillisecondLater)).toEqual([task.nav.id, task.footer.id, task.copy.id]);

  const fromOnly = await listTasks(
    acme.id,
    project.id,
    alice.id,
    '?dueFrom=2026-05-20T12:00:00.000Z',
  );
  expect(idsOf(fromOnly)).toEqual([task.copy.id, task.ci.id]);

  const toOnly = await listTasks(acme.id, project.id, alice.id, '?dueTo=2026-05-10T12:00:00.000Z');
  expect(idsOf(toOnly)).toEqual([task.nav.id, task.banner.id]);
});

test('the second page of a filtered list holds the five oldest matches', async () => {
  const { alice, acme, project } = await setup();
  const newest = Date.parse('2026-05-04T09:00:00.000Z');
  await prisma.task.createMany({
    data: Array.from({ length: 30 }, (_, index) => ({
      orgId: acme.id,
      projectId: project.id,
      createdBy: alice.id,
      title: `Task ${index + 1}`,
      // The last five are done, so 25 of the 30 match the filter below.
      status: (index < 25 ? 'todo' : 'done') as TaskStatus,
      createdAt: new Date(newest - index * 1000),
    })),
  });

  const page1 = await listTasks(acme.id, project.id, alice.id, '?status=todo&page=1&limit=20');
  const page2 = await listTasks(acme.id, project.id, alice.id, '?status=todo&page=2&limit=20');

  expect(page2.json()).toMatchObject({ total: 25, page: 2, limit: 20 });
  expect(page2.json().data).toHaveLength(5);
  expect(page2.json().data.map((task: { title: string }) => task.title)).toEqual([
    'Task 21',
    'Task 22',
    'Task 23',
    'Task 24',
    'Task 25',
  ]);
  expect(page1.json().data).toHaveLength(20);
  expect(idsOf(page1).filter((id) => idsOf(page2).includes(id))).toEqual([]);
});

test('a task of another org is missing under your org and forbidden under theirs', async () => {
  const { alice, acme } = await setup();
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const globex = await createOrg(dan.id, 'Globex');
  const theirProject = await createProject(globex.id, dan.id, 'Warehouse Sync');
  const theirTask = await seedTask(globex.id, theirProject.id, dan.id, 0, {
    title: 'Reconcile the pallet counts',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });

  const underOwnOrg = tasksUrl(acme.id, theirProject.id, `/${theirTask.id}`);
  const read = await app.inject({ method: 'GET', url: underOwnOrg, headers: asUser(alice.id) });
  const patched = await app.inject({
    method: 'PATCH',
    url: underOwnOrg,
    headers: asUser(alice.id),
    body: { status: 'done' },
  });
  const deleted = await app.inject({
    method: 'DELETE',
    url: underOwnOrg,
    headers: asUser(alice.id),
  });
  for (const res of [read, patched, deleted]) {
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  }

  const bulk = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: { taskIds: [theirTask.id], status: 'done' },
  });
  expect(bulk.statusCode).toBe(200);
  expect(bulk.json()).toEqual({ updated: 0 });

  const underTheirOrg = await app.inject({
    method: 'GET',
    url: tasksUrl(globex.id, theirProject.id, `/${theirTask.id}`),
    headers: asUser(alice.id),
  });
  const bulkUnderTheirOrg = await app.inject({
    method: 'POST',
    url: `/api/orgs/${globex.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: { taskIds: [theirTask.id], status: 'done' },
  });
  for (const res of [underTheirOrg, bulkUnderTheirOrg]) {
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(FORBIDDEN);
  }

  // Nothing above touched the row.
  expect(await prisma.task.findUniqueOrThrow({ where: { id: theirTask.id } })).toMatchObject({
    status: 'todo',
    deletedAt: null,
  });
});

test('a task whose project was deleted is gone from every read and from bulk updates', async () => {
  const { alice, acme, project } = await setup();
  const doomed = await createProject(acme.id, alice.id, 'Mobile App');
  const orphan = await seedTask(acme.id, doomed.id, alice.id, 0, {
    title: 'Wire up the push tokens',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });
  const kept = await seedTask(acme.id, project.id, alice.id, 0, {
    title: 'Draft the new nav',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });

  await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${doomed.id}`,
    headers: asUser(alice.id),
  });

  const listed = await listTasks(acme.id, doomed.id, alice.id);
  expect(listed.statusCode).toBe(404);
  expect(listed.json()).toEqual(NO_PROJECT);

  const read = await app.inject({
    method: 'GET',
    url: tasksUrl(acme.id, doomed.id, `/${orphan.id}`),
    headers: asUser(alice.id),
  });
  expect(read.statusCode).toBe(404);
  expect(read.json()).toEqual(NOT_FOUND);

  const created = await app.inject({
    method: 'POST',
    url: tasksUrl(acme.id, doomed.id),
    headers: asUser(alice.id),
    body: { title: 'Wire up the deep links' },
  });
  expect(created.statusCode).toBe(404);
  expect(created.json()).toEqual(NO_PROJECT);

  const bulk = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: { taskIds: [orphan.id, kept.id], status: 'done' },
  });
  expect(bulk.json()).toEqual({ updated: 1 });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({
    status: 'todo',
  });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
    status: 'done',
  });
});

test('a bulk update applies to the ids the caller may touch and counts only those', async () => {
  const { alice, acme, project } = await setup();
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const globex = await createOrg(dan.id, 'Globex');
  const theirProject = await createProject(globex.id, dan.id, 'Warehouse Sync');
  const task = await seedFilterFixtures(acme.id, project.id, alice.id);
  const theirs = await seedTask(globex.id, theirProject.id, dan.id, 0, {
    title: 'Reconcile the pallet counts',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });
  await app.inject({
    method: 'DELETE',
    url: tasksUrl(acme.id, project.id, `/${task.banner.id}`),
    headers: asUser(alice.id),
  });

  const bulk = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: {
      taskIds: [
        task.nav.id,
        task.footer.id,
        theirs.id,
        task.banner.id,
        '0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e77',
      ],
      status: 'review',
    },
  });

  expect(bulk.statusCode).toBe(200);
  expect(bulk.json()).toEqual({ updated: 2 });
  const statusOf = async (id: string) =>
    (await prisma.task.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
  expect(await statusOf(task.nav.id)).toBe('review');
  expect(await statusOf(task.footer.id)).toBe('review');
  // Soft-deleted, another org's, and never listed at all: all three keep their status.
  expect(await statusOf(task.banner.id)).toBe('todo');
  expect(await statusOf(theirs.id)).toBe('todo');
  expect(await statusOf(task.ci.id)).toBe('todo');
});

test('an invalid filter, body, or empty patch is a validation error', async () => {
  const { alice, acme, project } = await setup();
  const task = await seedTask(acme.id, project.id, alice.id, 0, {
    title: 'Draft the new nav',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });

  const queries = [
    '?status=blocked',
    '?priority=critical',
    '?assigneeId=not-a-uuid',
    '?dueFrom=2026-05-01',
    '?dueTo=tomorrow',
    '?limit=500',
  ];
  for (const query of queries) {
    const res = await listTasks(acme.id, project.id, alice.id, query);
    expect(res.statusCode, query).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  }

  const untitled = await app.inject({
    method: 'POST',
    url: tasksUrl(acme.id, project.id),
    headers: asUser(alice.id),
    body: { description: 'No title given' },
  });
  expect(untitled.statusCode).toBe(400);
  expect(untitled.json().details.fieldErrors.title).toEqual([expect.any(String)]);

  const blank = await app.inject({
    method: 'POST',
    url: tasksUrl(acme.id, project.id),
    headers: asUser(alice.id),
    body: { title: '   ' },
  });
  expect(blank.statusCode).toBe(400);

  const unknownStatus = await app.inject({
    method: 'POST',
    url: tasksUrl(acme.id, project.id),
    headers: asUser(alice.id),
    body: { title: 'Draft the new nav', status: 'blocked' },
  });
  expect(unknownStatus.statusCode).toBe(400);

  const empty = await app.inject({
    method: 'PATCH',
    url: tasksUrl(acme.id, project.id, `/${task.id}`),
    headers: asUser(alice.id),
    body: {},
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toEqual({
    error: expect.any(String),
    code: 'VALIDATION_ERROR',
    details: { fieldErrors: { body: ['Provide at least one field to update'] } },
  });

  const emptyBulk = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: { taskIds: [], status: 'done' },
  });
  expect(emptyBulk.statusCode).toBe(400);
  expect(emptyBulk.json()).toMatchObject({ code: 'VALIDATION_ERROR' });

  const oversizedBulk = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/tasks/bulk-status`,
    headers: asUser(alice.id),
    body: { taskIds: Array.from({ length: 101 }, () => randomUUID()), status: 'done' },
  });
  expect(oversizedBulk.statusCode).toBe(400);
  expect(oversizedBulk.json()).toMatchObject({
    code: 'VALIDATION_ERROR',
    details: { fieldErrors: { taskIds: [expect.any(String)] } },
  });
});

test('any member may delete a task, unlike the project that holds it', async () => {
  const { alice, ben, acme, project } = await setup();
  const task = await seedTask(acme.id, project.id, alice.id, 0, {
    title: 'Draft the new nav',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });

  const deleted = await app.inject({
    method: 'DELETE',
    url: tasksUrl(acme.id, project.id, `/${task.id}`),
    headers: asUser(ben.id),
  });
  expect(deleted.statusCode).toBe(204);

  const again = await app.inject({
    method: 'DELETE',
    url: tasksUrl(acme.id, project.id, `/${task.id}`),
    headers: asUser(ben.id),
  });
  expect(again.statusCode).toBe(404);
  expect(again.json()).toEqual(NOT_FOUND);
});

test('task routes without an access token are unauthorized, not forbidden', async () => {
  const { alice, acme, project } = await setup();
  const task = await seedTask(acme.id, project.id, alice.id, 0, {
    title: 'Draft the new nav',
    status: 'todo',
    priority: 'high',
    dueDate: null,
  });

  const responses = await Promise.all([
    app.inject({ method: 'GET', url: tasksUrl(acme.id, project.id) }),
    app.inject({ method: 'POST', url: tasksUrl(acme.id, project.id), body: { title: 'Anything' } }),
    app.inject({ method: 'GET', url: tasksUrl(acme.id, project.id, `/${task.id}`) }),
    app.inject({
      method: 'PATCH',
      url: tasksUrl(acme.id, project.id, `/${task.id}`),
      body: { status: 'done' },
    }),
    app.inject({ method: 'DELETE', url: tasksUrl(acme.id, project.id, `/${task.id}`) }),
    app.inject({
      method: 'POST',
      url: `/api/orgs/${acme.id}/tasks/bulk-status`,
      body: { taskIds: [task.id], status: 'done' },
    }),
    app.inject({ method: 'GET', url: `/api/orgs/${acme.id}/tasks/search?q=nav` }),
  ]);

  for (const res of responses) {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'UNAUTHORIZED', details: {} });
  }
});
