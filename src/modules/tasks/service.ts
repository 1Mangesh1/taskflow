import { Prisma, type TaskPriority, type TaskStatus } from '../../generated/prisma/client.js';
import { TaskNotFoundError } from '../../lib/errors.js';
import type { Pagination } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { getProject } from '../projects/service.js';

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date;
};
export type TaskPatch = {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
};
export type TaskFilters = {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  assigneeId?: string;
  dueFrom?: Date;
  dueTo?: Date;
};
export type TaskListQuery = Pagination & { filters: TaskFilters };

const taskFields = {
  id: true,
  projectId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueDate: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Deleting a project deliberately leaves its tasks untouched (see ../projects/service.ts),
// so the task's own deleted_at is not enough: every query has to reject tasks whose
// project is gone as well.
const visible = (orgId: string) => ({ orgId, deletedAt: null, project: { deletedAt: null } });

export function taskWhere(
  orgId: string,
  projectId: string,
  filters: TaskFilters,
): Prisma.TaskWhereInput {
  return {
    ...visible(orgId),
    projectId,
    ...(filters.status && { status: { in: filters.status } }),
    ...(filters.priority && { priority: { in: filters.priority } }),
    ...(filters.assigneeId && { assignments: { some: { userId: filters.assigneeId } } }),
    ...((filters.dueFrom || filters.dueTo) && {
      dueDate: {
        ...(filters.dueFrom && { gte: filters.dueFrom }),
        ...(filters.dueTo && { lte: filters.dueTo }),
      },
    }),
  };
}

export async function createTask(
  orgId: string,
  projectId: string,
  createdBy: string,
  input: TaskInput,
) {
  // Proves the parent project is this org's and not soft-deleted before anything is
  // written; org_id below is therefore the project's own org, which is the invariant
  // the denormalized column carries.
  await getProject(orgId, projectId);

  // Input first: the derived columns are written last so no client-supplied field can
  // take their place.
  return prisma.task.create({
    data: { ...input, orgId, projectId, createdBy },
    select: taskFields,
  });
}

export async function listTasks(orgId: string, projectId: string, query: TaskListQuery) {
  // Worth the extra round trip: without it a project that is another org's, deleted, or
  // never existed answers with an empty page, which reads as "no tasks yet" instead of
  // the 404 every other project-scoped route gives.
  await getProject(orgId, projectId);

  const where = taskWhere(orgId, projectId, query.filters);
  const [data, total] = await Promise.all([
    prisma.task.findMany({
      where,
      select: taskFields,
      // The id breaks ties: tasks sharing a created_at would otherwise be free to swap
      // pages between two requests, dropping or duplicating rows.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: query.skip,
      take: query.take,
    }),
    prisma.task.count({ where }),
  ]);

  return { data, total, page: query.page, limit: query.limit };
}

export async function getTask(orgId: string, projectId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId, ...visible(orgId) },
    select: {
      ...taskFields,
      assignments: {
        select: { user: { select: { id: true, email: true, name: true } } },
        // The id breaks ties: a batch of assignments written in one statement shares a
        // created_at, which would leave the assignee order up to the planner.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      _count: { select: { comments: true } },
    },
  });
  if (!task) throw new TaskNotFoundError();

  const { assignments, _count, ...rest } = task;
  return {
    ...rest,
    assignees: assignments.map(({ user }) => ({
      userId: user.id,
      email: user.email,
      name: user.name,
    })),
    commentCount: _count.comments,
  };
}

export async function updateTask(
  orgId: string,
  projectId: string,
  taskId: string,
  patch: TaskPatch,
) {
  // updateManyAndReturn, not update: the visibility filter reaches into the project row,
  // which a unique-where cannot express.
  const [task] = await prisma.task.updateManyAndReturn({
    where: { id: taskId, projectId, ...visible(orgId) },
    data: patch,
    select: taskFields,
  });
  if (!task) throw new TaskNotFoundError();

  return task;
}

export async function softDeleteTask(orgId: string, projectId: string, taskId: string) {
  const { count } = await prisma.task.updateMany({
    where: { id: taskId, projectId, ...visible(orgId) },
    data: { deletedAt: new Date() },
  });
  if (count === 0) throw new TaskNotFoundError();
}

// Ids outside the org, already deleted, or in a deleted project simply do not match:
// a partial list is applied as far as it is the caller's to apply, and the count says
// how far that was.
export async function bulkUpdateStatus(orgId: string, taskIds: string[], status: TaskStatus) {
  const { count } = await prisma.task.updateMany({
    where: { id: { in: taskIds }, ...visible(orgId) },
    data: { status },
  });

  return { updated: count };
}

// Derived, not restated: the raw SELECT below has to match what the list route returns,
// so the row type follows taskFields instead of drifting from it.
type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskFields }>;

export async function searchTasks(orgId: string, q: string, page: Pagination) {
  // The only raw SQL in the codebase: tsvector, ts_rank, and the weighting they read
  // have no Prisma equivalent. Every value below is a bound parameter, so the search
  // text stays search text and can never become SQL.
  const tsquery = Prisma.sql`websearch_to_tsquery('english', ${q})`;
  const matches = Prisma.sql`
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ${orgId}::uuid
      AND t.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND t.search_vector @@ ${tsquery}`;

  const [data, [{ total }]] = await Promise.all([
    prisma.$queryRaw<TaskRow[]>`
      SELECT t.id, t.project_id AS "projectId", t.title, t.description, t.status, t.priority,
             t.due_date AS "dueDate", t.created_by AS "createdBy",
             t.created_at AS "createdAt", t.updated_at AS "updatedAt"
      ${matches}
      ORDER BY ts_rank(t.search_vector, ${tsquery}) DESC, t.id DESC
      LIMIT ${page.take} OFFSET ${page.skip}`,
    prisma.$queryRaw<[{ total: number }]>`SELECT COUNT(*)::int AS total ${matches}`,
  ]);

  return { data, total, page: page.page, limit: page.limit };
}
