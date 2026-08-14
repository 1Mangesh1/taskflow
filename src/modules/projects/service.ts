import { Prisma, type TaskStatus } from '../../generated/prisma/client.js';
import { ProjectNotFoundError } from '../../lib/errors.js';
import type { Pagination } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';

export type ProjectInput = { name: string; description?: string };
export type ProjectPatch = { name?: string; description?: string };

const projectFields = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Every read and write goes through this filter: a soft-deleted project and a project
// belonging to another org are both simply not there.
const visible = (orgId: string, projectId: string) => ({ id: projectId, orgId, deletedAt: null });

export function createProject(orgId: string, input: ProjectInput) {
  return prisma.project.create({ data: { orgId, ...input }, select: projectFields });
}

export async function listProjects(orgId: string, page: Pagination) {
  const where = { orgId, deletedAt: null };
  const [data, total] = await Promise.all([
    prisma.project.findMany({
      where,
      select: projectFields,
      // The id breaks ties: created_at holds milliseconds, and projects sharing one
      // would otherwise be free to swap pages between two requests.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.project.count({ where }),
  ]);

  return { data, total, page: page.page, limit: page.limit };
}

export async function getProject(orgId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: visible(orgId, projectId),
    select: projectFields,
  });
  if (!project) throw new ProjectNotFoundError();

  return project;
}

export async function updateProject(orgId: string, projectId: string, patch: ProjectPatch) {
  try {
    return await prisma.project.update({
      where: visible(orgId, projectId),
      data: patch,
      select: projectFields,
    });
  } catch (err) {
    // The filter matched nothing: the project is deleted, or not this org's.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new ProjectNotFoundError();
    }
    throw err;
  }
}

export async function softDeleteProject(orgId: string, projectId: string) {
  // Tasks keep their own deleted_at: they are only reachable through their project,
  // which this hides, and cascading would be an unbounded write behind a 204.
  const { count } = await prisma.project.updateMany({
    where: visible(orgId, projectId),
    data: { deletedAt: new Date() },
  });
  if (count === 0) throw new ProjectNotFoundError();
}

export async function projectDashboard(orgId: string, projectId: string) {
  await getProject(orgId, projectId);

  const grouped = await prisma.task.groupBy({
    by: ['status'],
    where: { orgId, projectId, deletedAt: null },
    _count: true,
  });

  // A status with no tasks has no row in the result, so the counts start at zero
  // rather than being built from what came back.
  const counts: Record<TaskStatus, number> = { todo: 0, in_progress: 0, review: 0, done: 0 };
  for (const row of grouped) counts[row.status] = row._count;

  return { projectId, counts, total: grouped.reduce((sum, row) => sum + row._count, 0) };
}
