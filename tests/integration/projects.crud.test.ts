import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

const NOT_FOUND = { error: expect.any(String), code: 'PROJECT_NOT_FOUND', details: {} };
const FORBIDDEN = { error: expect.any(String), code: 'FORBIDDEN', details: {} };

let app: FastifyInstance;

// Tokens are signed with the app's own key rather than obtained through
// /api/auth/login: these tests are about projects, and logging in would cost a bcrypt
// hash per user and most of the auth rate limit budget.
const asUser = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId })}` });

const createOrg = (userId: string, name: string) =>
  app
    .inject({ method: 'POST', url: '/api/orgs', headers: asUser(userId), body: { name } })
    .then((res) => res.json());

const addMember = (orgId: string, adminId: string, email: string) =>
  app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/members`,
    headers: asUser(adminId),
    body: { email, role: 'member' },
  });

const createProject = (orgId: string, userId: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/orgs/${orgId}/projects`, headers: asUser(userId), body });

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('a project is created, read, listed, patched, and deleted', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');

  const created = await createProject(acme.id, alice.id, {
    name: 'Website Redesign',
    description: 'Rebuild the marketing site',
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({
    id: expect.any(String),
    name: 'Website Redesign',
    description: 'Rebuild the marketing site',
    createdAt: expect.any(String),
  });
  const { id } = created.json();

  const read = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toEqual({
    id,
    name: 'Website Redesign',
    description: 'Rebuild the marketing site',
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });

  const listed = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects`,
    headers: asUser(alice.id),
  });
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual({ data: [read.json()], total: 1, page: 1, limit: 20 });

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
    body: { name: 'Website Relaunch' },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({
    id,
    name: 'Website Relaunch',
    description: 'Rebuild the marketing site',
  });

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(deleted.statusCode).toBe(204);
});

test('a member creates and patches projects but only an admin deletes them', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const acme = await createOrg(alice.id, 'Acme Corp');
  await addMember(acme.id, alice.id, ben.email);

  const created = await createProject(acme.id, ben.id, { name: 'Website Redesign' });
  expect(created.statusCode).toBe(201);
  const { id } = created.json();

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(ben.id),
    body: { description: 'Rebuild the marketing site' },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({ description: 'Rebuild the marketing site' });

  const byMember = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(ben.id),
  });
  expect(byMember.statusCode).toBe(403);
  expect(byMember.json()).toEqual(FORBIDDEN);

  const byAdmin = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(byAdmin.statusCode).toBe(204);
});

test('a deleted project leaves the list, reads as missing, and stays deleted', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const kept = await createProject(acme.id, alice.id, { name: 'Mobile App' });
  const { id } = (await createProject(acme.id, alice.id, { name: 'Website Redesign' })).json();

  await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });

  const listed = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects`,
    headers: asUser(alice.id),
  });
  expect(listed.json().data.map((project: { id: string }) => project.id)).toEqual([kept.json().id]);
  expect(listed.json().total).toBe(1);

  const read = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(read.statusCode).toBe(404);
  expect(read.json()).toEqual(NOT_FOUND);

  const deletedAgain = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(deletedAgain.statusCode).toBe(404);
  expect(deletedAgain.json()).toEqual(NOT_FOUND);

  // The row survives the delete: soft delete is a filter, not a removal.
  expect(await prisma.project.count()).toBe(2);
});

// Two different answers on purpose: under her own org the project simply does not
// exist, and under Globex Alice never gets far enough to learn whether it does.
test('a project of another org is missing under your org and forbidden under theirs', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const globex = await createOrg(dan.id, 'Globex');
  const { id } = (await createProject(globex.id, dan.id, { name: 'Warehouse Sync' })).json();

  const underOwnOrg = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(underOwnOrg.statusCode).toBe(404);
  expect(underOwnOrg.json()).toEqual(NOT_FOUND);

  const underTheirOrg = await app.inject({
    method: 'GET',
    url: `/api/orgs/${globex.id}/projects/${id}`,
    headers: asUser(alice.id),
  });
  expect(underTheirOrg.statusCode).toBe(403);
  expect(underTheirOrg.json()).toEqual(FORBIDDEN);

  // The whole list is scoped too, not just reads by id.
  const listed = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects`,
    headers: asUser(alice.id),
  });
  expect(listed.json()).toEqual({ data: [], total: 0, page: 1, limit: 20 });
});

test('the second page of twenty-five projects holds the five oldest', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');
  // Seeded directly with distinct timestamps: 25 POSTs would only re-test the create
  // route, and rows sharing a millisecond would make "newest first" ambiguous.
  const createdAt = Date.parse('2026-05-04T09:00:00.000Z');
  await prisma.project.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      orgId: acme.id,
      name: `Project ${index + 1}`,
      createdAt: new Date(createdAt - index * 1000),
    })),
  });

  const page2 = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects?page=2&limit=20`,
    headers: asUser(alice.id),
  });
  expect(page2.statusCode).toBe(200);
  expect(page2.json()).toMatchObject({ total: 25, page: 2, limit: 20 });
  expect(page2.json().data.map((project: { name: string }) => project.name)).toEqual([
    'Project 21',
    'Project 22',
    'Project 23',
    'Project 24',
    'Project 25',
  ]);

  const page1 = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects?page=1&limit=20`,
    headers: asUser(alice.id),
  });
  expect(page1.json().data).toHaveLength(20);
  expect(page1.json().data[0].name).toBe('Project 1');

  const tooMany = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects?limit=500`,
    headers: asUser(alice.id),
  });
  expect(tooMany.statusCode).toBe(400);
  expect(tooMany.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('the dashboard counts tasks by status and reports the empty ones as zero', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const { id } = (await createProject(acme.id, alice.id, { name: 'Website Redesign' })).json();
  await prisma.task.createMany({
    data: [
      { orgId: acme.id, projectId: id, createdBy: alice.id, title: 'Draft the new nav' },
      { orgId: acme.id, projectId: id, createdBy: alice.id, title: 'Rebuild the footer' },
      {
        orgId: acme.id,
        projectId: id,
        createdBy: alice.id,
        title: 'Audit the copy',
        status: 'review',
      },
      {
        orgId: acme.id,
        projectId: id,
        createdBy: alice.id,
        title: 'Retire the old banner',
        status: 'done',
        deletedAt: new Date(),
      },
    ],
  });

  const res = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/projects/${id}/dashboard`,
    headers: asUser(alice.id),
  });

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    projectId: id,
    counts: { todo: 2, in_progress: 0, review: 1, done: 0 },
    total: 3,
  });
});

test('a project name is required and a patch has to change something', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const { id } = (await createProject(acme.id, alice.id, { name: 'Website Redesign' })).json();

  const unnamed = await createProject(acme.id, alice.id, { description: 'No name given' });
  expect(unnamed.statusCode).toBe(400);
  expect(unnamed.json()).toMatchObject({ code: 'VALIDATION_ERROR' });

  const tooLong = await createProject(acme.id, alice.id, { name: 'x'.repeat(201) });
  expect(tooLong.statusCode).toBe(400);

  const empty = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${acme.id}/projects/${id}`,
    headers: asUser(alice.id),
    body: {},
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
});

test('project routes without an access token are unauthorized, not forbidden', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const { id } = (await createProject(acme.id, alice.id, { name: 'Website Redesign' })).json();

  const responses = await Promise.all([
    app.inject({ method: 'GET', url: `/api/orgs/${acme.id}/projects` }),
    app.inject({
      method: 'POST',
      url: `/api/orgs/${acme.id}/projects`,
      body: { name: 'Mobile App' },
    }),
    app.inject({ method: 'GET', url: `/api/orgs/${acme.id}/projects/${id}` }),
    app.inject({
      method: 'PATCH',
      url: `/api/orgs/${acme.id}/projects/${id}`,
      body: { name: 'Mobile App' },
    }),
    app.inject({ method: 'DELETE', url: `/api/orgs/${acme.id}/projects/${id}` }),
    app.inject({ method: 'GET', url: `/api/orgs/${acme.id}/projects/${id}/dashboard` }),
  ]);

  for (const res of responses) {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'UNAUTHORIZED', details: {} });
  }
});
