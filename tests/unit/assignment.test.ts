import { beforeEach, expect, test } from 'vitest';
import { addMember, createOrg } from '../../src/modules/orgs/service.js';
import { createProject, softDeleteProject } from '../../src/modules/projects/service.js';
import { assigneeBody } from '../../src/modules/tasks/routes.js';
import * as taskService from '../../src/modules/tasks/service.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

beforeEach(truncateAll);

// Alice runs Acme and assigns; Ben is the member she assigns to; Dan is nobody's
// colleague until a test makes him one.
async function setup() {
  const alice = await createUser('alice.navarro@acme-corp.example', 'Alice Navarro');
  const ben = await createUser('ben.okafor@acme-corp.example', 'Ben Okafor');
  const dan = await createUser('dan.whitfield@globex.example', 'Dan Whitfield');
  const acme = await createOrg(alice.id, 'Acme Corp');
  await addMember(acme.id, { email: ben.email, role: 'member' });
  const project = await createProject(acme.id, { name: 'Website Redesign' });
  const task = await taskService.createTask(acme.id, project.id, alice.id, {
    title: 'Draft the new nav',
  });

  return { alice, ben, dan, acme, project, task };
}

test('an assignment carries everything the email worker needs, with no lookup left to do', async () => {
  const { alice, ben, acme, project, task } = await setup();

  const { assignment, email } = await taskService.assignUser(
    acme.id,
    project.id,
    task.id,
    ben.id,
    alice.id,
  );

  expect(assignment).toEqual({
    taskId: task.id,
    userId: ben.id,
    assignedBy: alice.id,
    createdAt: expect.any(Date),
  });
  expect(email).toEqual({
    taskId: task.id,
    taskTitle: 'Draft the new nav',
    assigneeId: ben.id,
    assigneeEmail: 'ben.okafor@acme-corp.example',
    assignerId: alice.id,
    assignerName: 'Alice Navarro',
    orgId: acme.id,
  });
});

test('a user outside the organization cannot be assigned, even in an org of their own', async () => {
  const { alice, dan, acme, project, task } = await setup();
  await createOrg(dan.id, 'Globex');

  await expect(
    taskService.assignUser(acme.id, project.id, task.id, dan.id, alice.id),
  ).rejects.toMatchObject({ code: 'USER_NOT_ORG_MEMBER', httpStatus: 400 });
  expect(await prisma.taskAssignment.count()).toBe(0);
});

test('the same user cannot be assigned to one task twice', async () => {
  const { alice, ben, acme, project, task } = await setup();
  await taskService.assignUser(acme.id, project.id, task.id, ben.id, alice.id);

  await expect(
    taskService.assignUser(acme.id, project.id, task.id, ben.id, alice.id),
  ).rejects.toMatchObject({ code: 'ALREADY_ASSIGNED', httpStatus: 409 });
  expect(await prisma.taskAssignment.count()).toBe(1);
});

// The visibility gate is the tasks module's own: a task in a soft-deleted project is
// gone for assignment exactly as it is for every other task route.
test('a task whose project was deleted can no longer be assigned', async () => {
  const { alice, ben, acme, project, task } = await setup();
  await softDeleteProject(acme.id, project.id);

  await expect(
    taskService.assignUser(acme.id, project.id, task.id, ben.id, alice.id),
  ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
});

test('unassigning removes the row, and unassigning again says there is nothing to remove', async () => {
  const { alice, ben, acme, project, task } = await setup();
  await taskService.assignUser(acme.id, project.id, task.id, ben.id, alice.id);

  await taskService.unassignUser(acme.id, project.id, task.id, ben.id);
  expect(await prisma.taskAssignment.count()).toBe(0);

  await expect(
    taskService.unassignUser(acme.id, project.id, task.id, ben.id),
  ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', httpStatus: 404 });
});

// assigned_by is taken from the access token, so a body that tries to name someone else
// as the assigner is not a way in.
test('the request body carries the assignee and nothing else', () => {
  const userId = '0199a1f0-9c1a-7c3e-8a4b-4d2f6a5c1e79';

  expect(assigneeBody.parse({ userId, assignedBy: userId })).toEqual({ userId });
  expect(assigneeBody.safeParse({ userId: 'ben' }).success).toBe(false);
  expect(assigneeBody.safeParse({}).success).toBe(false);
});
