import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { asUser, buildTestApp, createOrg, createProject } from '../helpers/app.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

let app: FastifyInstance;

const search = (orgId: string, userId: string, query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/orgs/${orgId}/tasks/search?${query}`,
    headers: asUser(app, userId),
  });

const titlesOf = (res: { json: () => { data: { title: string }[] } }) =>
  res.json().data.map((task) => task.title);

const seedTask = (
  orgId: string,
  projectId: string,
  createdBy: string,
  title: string,
  description: string | null,
  deletedAt: Date | null = null,
) =>
  prisma.task.create({
    data: { orgId, projectId, createdBy, title, description, deletedAt },
    select: { id: true },
  });

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(() => app.close());

// title is indexed at weight A and description at weight B, so the same word is worth
// more in a title: that is the whole point of the weighted search vector.
test('a match in the title outranks a match in the description', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  // The title match is inserted first on purpose: the id tiebreaker would put the
  // newer row first, so only the rank can produce the order asserted below.
  await seedTask(
    acme.id,
    project.id,
    alice.id,
    'Checkout flow rewrite',
    'Bank redirects and retries',
  );
  await seedTask(
    acme.id,
    project.id,
    alice.id,
    'Analytics dashboard',
    'Funnel tracking for the checkout journey',
  );

  const res = await search(acme.id, alice.id, 'q=checkout');

  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ total: 2, page: 1, limit: 20 });
  expect(titlesOf(res)).toEqual(['Checkout flow rewrite', 'Analytics dashboard']);
});

test('the search reads the same stemmed english the index was built with', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  await seedTask(acme.id, project.id, alice.id, 'Retrying failed payments', null);

  // Both sides are stemmed by the same english dictionary: "retry" finds "Retrying"
  // and "payment" finds "payments", which a LIKE '%...%' fallback would not.
  expect(titlesOf(await search(acme.id, alice.id, 'q=retry'))).toEqual([
    'Retrying failed payments',
  ]);
  expect(titlesOf(await search(acme.id, alice.id, 'q=failed+payment'))).toEqual([
    'Retrying failed payments',
  ]);
});

test('a term that matches nothing is an empty page, not an error', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  await seedTask(acme.id, project.id, alice.id, 'Checkout flow rewrite', 'Bank redirects');

  const res = await search(acme.id, alice.id, 'q=warehouse');

  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ data: [], total: 0, page: 1, limit: 20 });
});

test('the search is scoped to the org and skips deleted tasks and deleted projects', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const globex = await createOrg(app, dan.id, 'Globex');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  const doomed = await createProject(app, acme.id, alice.id, 'Mobile App');
  const theirProject = await createProject(app, globex.id, dan.id, 'Warehouse Sync');

  await seedTask(acme.id, project.id, alice.id, 'Checkout flow rewrite', 'Bank redirects');
  await seedTask(acme.id, project.id, alice.id, 'Checkout copy review', null, new Date());
  await seedTask(acme.id, doomed.id, alice.id, 'Checkout in the mobile app', null);
  await seedTask(globex.id, theirProject.id, dan.id, 'Checkout for pallet orders', null);
  await app.inject({
    method: 'DELETE',
    url: `/api/orgs/${acme.id}/projects/${doomed.id}`,
    headers: asUser(app, alice.id),
  });

  const mine = await search(acme.id, alice.id, 'q=checkout');
  expect(titlesOf(mine)).toEqual(['Checkout flow rewrite']);
  expect(mine.json().total).toBe(1);

  const theirs = await search(globex.id, alice.id, 'q=checkout');
  expect(theirs.statusCode).toBe(403);
});

test('the search pages the same way every other list does', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  await prisma.task.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      orgId: acme.id,
      projectId: project.id,
      createdBy: alice.id,
      title: `Checkout step ${index + 1}`,
    })),
  });

  const page1 = await search(acme.id, alice.id, 'q=checkout&page=1&limit=20');
  const page2 = await search(acme.id, alice.id, 'q=checkout&page=2&limit=20');

  expect(page1.json()).toMatchObject({ total: 25, page: 1, limit: 20 });
  expect(page1.json().data).toHaveLength(20);
  expect(page2.json()).toMatchObject({ total: 25, page: 2, limit: 20 });
  expect(page2.json().data).toHaveLength(5);
  const seen = page1.json().data.map((task: { id: string }) => task.id);
  expect(page2.json().data.filter((task: { id: string }) => seen.includes(task.id))).toEqual([]);
});

test('a missing or blank search term is a validation error', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');

  for (const query of ['', 'q=', 'q=%20%20%20', 'q=checkout&limit=101']) {
    const res = await search(acme.id, alice.id, query);
    expect(res.statusCode, query).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  }
});

// The one raw-SQL surface in the codebase: the search term is a bound parameter, so
// whatever it contains stays search text.
test('a search term shaped like an injection is just a search term', async () => {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const acme = await createOrg(app, alice.id, 'Acme Corp');
  const project = await createProject(app, acme.id, alice.id, 'Website Redesign');
  await seedTask(acme.id, project.id, alice.id, 'Checkout flow rewrite', 'Bank redirects');

  const injection = await search(
    acme.id,
    alice.id,
    `q=${encodeURIComponent("'; DROP TABLE tasks; --")}`,
  );
  const quoted = await search(acme.id, alice.id, `q=${encodeURIComponent('" OR 1=1 --')}`);

  expect(injection.statusCode).toBe(200);
  expect(injection.json()).toMatchObject({ total: 0, data: [] });
  expect(quoted.statusCode).toBe(200);
  // The table is still there with its row in it.
  expect(await prisma.task.count()).toBe(1);
  expect(titlesOf(await search(acme.id, alice.id, 'q=checkout'))).toEqual([
    'Checkout flow rewrite',
  ]);
});
