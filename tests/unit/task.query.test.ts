import { expect, test } from 'vitest';
import { taskListQuery } from '../../src/modules/tasks/routes.js';
import { taskWhere } from '../../src/modules/tasks/service.js';

const ORG = '0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e77';
const PROJECT = '0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e78';
const ASSIGNEE = '0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e79';
const FROM = new Date('2026-05-01T00:00:00.000Z');
const TO = new Date('2026-05-31T23:59:59.999Z');

test('an unfiltered query still hides other orgs, other projects, and deleted rows', () => {
  expect(taskWhere(ORG, PROJECT, {})).toEqual({
    orgId: ORG,
    projectId: PROJECT,
    deletedAt: null,
    // Deleting a project leaves its tasks untouched, so this join filter is the only
    // thing standing between a soft-deleted project and its tasks showing up.
    project: { deletedAt: null },
  });
});

test('status and priority each become one IN clause', () => {
  expect(taskWhere(ORG, PROJECT, { status: ['todo', 'review'] })).toEqual({
    orgId: ORG,
    projectId: PROJECT,
    deletedAt: null,
    project: { deletedAt: null },
    status: { in: ['todo', 'review'] },
  });
  expect(taskWhere(ORG, PROJECT, { priority: ['urgent'] }).priority).toEqual({ in: ['urgent'] });
  expect(taskWhere(ORG, PROJECT, {}).status).toBeUndefined();
});

test('an assignee is matched through the assignment rows, not a column on the task', () => {
  expect(taskWhere(ORG, PROJECT, { assigneeId: ASSIGNEE }).assignments).toEqual({
    some: { userId: ASSIGNEE },
  });
});

test('a due-date range is inclusive at both ends and either end may be left open', () => {
  expect(taskWhere(ORG, PROJECT, { dueFrom: FROM, dueTo: TO }).dueDate).toEqual({
    gte: FROM,
    lte: TO,
  });
  expect(taskWhere(ORG, PROJECT, { dueFrom: FROM }).dueDate).toEqual({ gte: FROM });
  expect(taskWhere(ORG, PROJECT, { dueTo: TO }).dueDate).toEqual({ lte: TO });
  expect(taskWhere(ORG, PROJECT, {}).dueDate).toBeUndefined();
});

test('two filters combine into one where clause rather than replacing each other', () => {
  expect(taskWhere(ORG, PROJECT, { status: ['done'], assigneeId: ASSIGNEE })).toEqual({
    orgId: ORG,
    projectId: PROJECT,
    deletedAt: null,
    project: { deletedAt: null },
    status: { in: ['done'] },
    assignments: { some: { userId: ASSIGNEE } },
  });
});

test('one querystring carries both the filters and the page', () => {
  expect(
    taskListQuery.parse({
      page: '2',
      limit: '10',
      status: 'todo,review',
      priority: 'urgent',
      assigneeId: ASSIGNEE,
      dueFrom: '2026-05-01T00:00:00.000Z',
      dueTo: '2026-05-31T23:59:59.999Z',
    }),
  ).toEqual({
    skip: 10,
    take: 10,
    page: 2,
    limit: 10,
    filters: {
      status: ['todo', 'review'],
      priority: ['urgent'],
      assigneeId: ASSIGNEE,
      dueFrom: FROM,
      dueTo: TO,
    },
  });
});

test('a query with no filters keeps the shared pagination defaults', () => {
  expect(taskListQuery.parse({})).toEqual({ skip: 0, take: 20, page: 1, limit: 20, filters: {} });
});

// The bounds live in the pagination helper: extending it must not fork them.
test('the pagination bounds still apply once filters are in the same querystring', () => {
  expect(taskListQuery.safeParse({ limit: '101', status: 'todo' }).success).toBe(false);
  expect(taskListQuery.safeParse({ page: '0', status: 'todo' }).success).toBe(false);
});

test('an unknown enum value, a malformed uuid, and a non-ISO date are all rejected', () => {
  for (const query of [
    { status: 'blocked' },
    { status: 'todo,blocked' },
    { status: '' },
    { priority: 'critical' },
    { assigneeId: 'not-a-uuid' },
    { dueFrom: '2026-05-01' },
    { dueTo: 'yesterday' },
  ]) {
    expect(taskListQuery.safeParse(query).success).toBe(false);
  }
});

// Multi-value filters take one comma-separated value; a repeated key is the other
// convention and is rejected rather than quietly supported as a second one.
test('a repeated filter key is not a second way to pass several values', () => {
  expect(taskListQuery.safeParse({ status: ['todo', 'review'] }).success).toBe(false);
});
