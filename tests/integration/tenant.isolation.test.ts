import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { buildTestApp } from '../helpers/app.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

const FORBIDDEN = { error: expect.any(String), code: 'FORBIDDEN', details: {} };

let app: FastifyInstance;

// Tokens are signed with the app's own key rather than obtained through
// /api/auth/login: these tests are about org access, and logging in four users
// would cost four bcrypt hashes and most of the auth rate limit budget.
const asUser = (userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: userId })}` });

const createOrg = (userId: string, name: string) =>
  app
    .inject({ method: 'POST', url: '/api/orgs', headers: asUser(userId), body: { name } })
    .then((res) => res.json());

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

test('an org is created with its creator as admin and shows up in their list', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');

  const created = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: asUser(alice.id),
    body: { name: 'Acme Corp' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({ id: expect.any(String), name: 'Acme Corp', role: 'org_admin' });

  const listed = await app.inject({ method: 'GET', url: '/api/orgs', headers: asUser(alice.id) });
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual({ data: [created.json()] });
});

// The token is signed and unexpired, so authentication passes; only the membership
// insert notices the user is gone. That must not read as a server fault.
test('a token whose user no longer exists cannot create an org', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/orgs',
    headers: asUser('0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e77'),
    body: { name: 'Acme Corp' },
  });

  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: expect.any(String), code: 'UNAUTHORIZED', details: {} });
  // The failed insert must take the org with it: an org with no admin can never be
  // read, managed, or deleted by anyone.
  expect(await prisma.organization.count()).toBe(0);
});

test('a member of one org cannot read the members of another', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const globex = await createOrg(dan.id, 'Globex');

  const crossTenant = await app.inject({
    method: 'GET',
    url: `/api/orgs/${globex.id}/members`,
    headers: asUser(alice.id),
  });

  expect(crossTenant.statusCode).toBe(403);
  expect(crossTenant.json()).toEqual(FORBIDDEN);
  const ownOrg = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(alice.id),
  });
  expect(ownOrg.statusCode).toBe(200);
});

// Non-membership and non-existence must be one answer: a distinct 404 would let a
// caller enumerate which org ids exist.
test('an org that does not exist is forbidden, not missing', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const globex = await createOrg(dan.id, 'Globex');

  const missing = await app.inject({
    method: 'GET',
    url: '/api/orgs/0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e77/members',
    headers: asUser(alice.id),
  });
  const notMine = await app.inject({
    method: 'GET',
    url: `/api/orgs/${globex.id}/members`,
    headers: asUser(alice.id),
  });

  expect(missing.statusCode).toBe(403);
  expect(missing.json()).toEqual(notMine.json());
});

// The plugin does not rely on the route declaring `params: orgParams`: a route that
// forgets it must still answer 403, not 500 from the uuid column.
test('an org id that is not a uuid is forbidden on an unvalidated route', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const unvalidated = buildApp();
  unvalidated.get(
    '/api/orgs/:orgId/probe',
    { onRequest: unvalidated.authenticate, preHandler: unvalidated.requireOrgMember },
    async (request) => request.org,
  );
  await unvalidated.ready();

  const res = await unvalidated.inject({
    method: 'GET',
    url: '/api/orgs/not-a-uuid/probe',
    headers: asUser(alice.id),
  });
  await unvalidated.close();

  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual(FORBIDDEN);
});

test('a member without the admin role reads members but cannot manage them', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const carla = await createUser('carla.mendes@acme-corp.example', 'Carla Mendes');
  const acme = await createOrg(alice.id, 'Acme Corp');
  await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(alice.id),
    body: { email: ben.email, role: 'member' },
  });

  const listed = await app.inject({
    method: 'GET',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(ben.id),
  });
  const added = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(ben.id),
    body: { email: carla.email, role: 'member' },
  });
  const promoted = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${acme.id}/members/${ben.id}`,
    headers: asUser(ben.id),
    body: { role: 'org_admin' },
  });
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/members/${alice.id}`,
    headers: asUser(ben.id),
  });

  expect(listed.statusCode).toBe(200);
  expect(listed.json().data.map((member: { userId: string }) => member.userId)).toEqual([
    alice.id,
    ben.id,
  ]);
  expect(added.statusCode).toBe(403);
  expect(added.json()).toEqual(FORBIDDEN);
  expect(promoted.statusCode).toBe(403);
  expect(promoted.json()).toEqual(FORBIDDEN);
  expect(removed.statusCode).toBe(403);
  expect(removed.json()).toEqual(FORBIDDEN);
});

test('an admin adds, promotes, and removes a member', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const acme = await createOrg(alice.id, 'Acme Corp');
  const members = () =>
    app.inject({
      method: 'GET',
      url: `/api/orgs/${acme.id}/members`,
      headers: asUser(alice.id),
    });

  const added = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(alice.id),
    body: { email: ben.email, role: 'member' },
  });
  expect(added.statusCode).toBe(201);
  expect(added.json()).toEqual({
    userId: ben.id,
    email: ben.email,
    name: 'Ben Okafor',
    role: 'member',
  });
  expect((await members()).json()).toEqual({
    data: [
      {
        userId: alice.id,
        email: alice.email,
        name: 'Alice Navarro',
        role: 'org_admin',
        joinedAt: expect.any(String),
      },
      {
        userId: ben.id,
        email: ben.email,
        name: 'Ben Okafor',
        role: 'member',
        joinedAt: expect.any(String),
      },
    ],
  });

  const promoted = await app.inject({
    method: 'PATCH',
    url: `/api/orgs/${acme.id}/members/${ben.id}`,
    headers: asUser(alice.id),
    body: { role: 'org_admin' },
  });
  expect(promoted.statusCode).toBe(200);
  expect(promoted.json()).toEqual({ userId: ben.id, role: 'org_admin' });

  // Allowed only because Ben is now an admin too.
  const selfRemoved = await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/members/${alice.id}`,
    headers: asUser(alice.id),
  });
  expect(selfRemoved.statusCode).toBe(204);
  expect((await members()).statusCode).toBe(403);
});

test('an unknown role is a validation error', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const acme = await createOrg(alice.id, 'Acme Corp');

  const res = await app.inject({
    method: 'POST',
    url: `/api/orgs/${acme.id}/members`,
    headers: asUser(alice.id),
    body: { email: ben.email, role: 'owner' },
  });

  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: { fieldErrors: { role: [expect.any(String)] } },
  });
});

test('org routes without an access token are unauthorized, not forbidden', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(alice.id, 'Acme Corp');

  const responses = await Promise.all([
    app.inject({ method: 'GET', url: '/api/orgs' }),
    app.inject({ method: 'POST', url: '/api/orgs', body: { name: 'Globex' } }),
    app.inject({ method: 'GET', url: `/api/orgs/${acme.id}/members` }),
    app.inject({
      method: 'POST',
      url: `/api/orgs/${acme.id}/members`,
      body: { email: 'ben.okafor@acme-corp.example', role: 'member' },
    }),
    app.inject({ method: 'DELETE', url: `/api/orgs/${acme.id}/members/${alice.id}` }),
    // Schema validation runs before preHandler, so authentication has to sit on
    // onRequest for a malformed id to answer 401 rather than 400.
    app.inject({ method: 'GET', url: '/api/orgs/not-a-uuid/members' }),
  ]);

  for (const res of responses) {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'UNAUTHORIZED', details: {} });
  }
});
