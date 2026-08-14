import { beforeEach, expect, test } from 'vitest';
import type { TaskStatus } from '../../src/generated/prisma/client.js';
import { createOrg } from '../../src/modules/orgs/service.js';
import * as projectService from '../../src/modules/projects/service.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

const ALICE = ['alice.navarro@acme-corp.example', 'Alice Navarro'] as const;

beforeEach(truncateAll);

// Tasks have no routes yet (they arrive with the tasks module), so the dashboard is
// exercised against rows written directly.
const addTasks = (
  orgId: string,
  projectId: string,
  createdBy: string,
  tasks: { title: string; status: TaskStatus; deletedAt?: Date }[],
) =>
  prisma.task.createMany({
    data: tasks.map((task) => ({ orgId, projectId, createdBy, ...task })),
  });

test('the dashboard reports every status, including the ones with no tasks', async () => {
  const alice = await createUser(...ALICE);
  const org = await createOrg(alice.id, 'Acme Corp');
  const project = await projectService.createProject(org.id, { name: 'Website Redesign' });
  await addTasks(org.id, project.id, alice.id, [
    { title: 'Draft the new nav', status: 'todo' },
    { title: 'Rebuild the footer', status: 'todo' },
    { title: 'Ship the pricing page', status: 'done' },
  ]);

  expect(await projectService.projectDashboard(org.id, project.id)).toEqual({
    projectId: project.id,
    counts: { todo: 2, in_progress: 0, review: 0, done: 1 },
    total: 3,
  });
});

test('the dashboard ignores soft-deleted tasks and tasks of other projects', async () => {
  const alice = await createUser(...ALICE);
  const org = await createOrg(alice.id, 'Acme Corp');
  const project = await projectService.createProject(org.id, { name: 'Website Redesign' });
  const other = await projectService.createProject(org.id, { name: 'Mobile App' });
  await addTasks(org.id, project.id, alice.id, [
    { title: 'Draft the new nav', status: 'in_progress' },
    { title: 'Retire the old banner', status: 'in_progress', deletedAt: new Date() },
    { title: 'Audit the copy', status: 'review' },
  ]);
  await addTasks(org.id, other.id, alice.id, [{ title: 'Set up CI', status: 'review' }]);

  expect(await projectService.projectDashboard(org.id, project.id)).toEqual({
    projectId: project.id,
    counts: { todo: 0, in_progress: 1, review: 1, done: 0 },
    total: 2,
  });
});

// A soft-deleted project is gone as far as every read path is concerned, so its
// dashboard has to answer the same way a project id from another org does.
test('a soft-deleted project has no dashboard, no reads, and cannot be deleted twice', async () => {
  const alice = await createUser(...ALICE);
  const org = await createOrg(alice.id, 'Acme Corp');
  const project = await projectService.createProject(org.id, { name: 'Website Redesign' });
  await addTasks(org.id, project.id, alice.id, [{ title: 'Draft the new nav', status: 'todo' }]);

  await projectService.softDeleteProject(org.id, project.id);

  for (const call of [
    () => projectService.getProject(org.id, project.id),
    () => projectService.projectDashboard(org.id, project.id),
    () => projectService.updateProject(org.id, project.id, { name: 'Website Relaunch' }),
    () => projectService.softDeleteProject(org.id, project.id),
  ]) {
    await expect(call()).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  }

  // Soft delete keeps the row and leaves its tasks untouched: nothing is rewritten,
  // the project filter is what hides them.
  const row = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  expect(row.deletedAt).toBeInstanceOf(Date);
  expect(await prisma.task.count({ where: { projectId: project.id, deletedAt: null } })).toBe(1);
});
