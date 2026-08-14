import { CommentNotFoundError, ForbiddenError } from '../../lib/errors.js';
import type { Pagination } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { requireVisibleTask } from '../tasks/service.js';

const commentFields = {
  id: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true } },
} as const;

export async function createComment(
  orgId: string,
  projectId: string,
  taskId: string,
  authorId: string,
  body: string,
) {
  await requireVisibleTask(orgId, projectId, taskId);

  return prisma.comment.create({ data: { taskId, authorId, body }, select: commentFields });
}

export async function listComments(
  orgId: string,
  projectId: string,
  taskId: string,
  page: Pagination,
) {
  await requireVisibleTask(orgId, projectId, taskId);

  const [data, total] = await Promise.all([
    prisma.comment.findMany({
      where: { taskId },
      select: commentFields,
      // Oldest first, because a comment thread reads as a conversation. The id breaks
      // ties so comments sharing a millisecond cannot swap pages between requests.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: page.skip,
      take: page.take,
    }),
    prisma.comment.count({ where: { taskId } }),
  ]);

  return { data, total, page: page.page, limit: page.limit };
}

export async function deleteComment(
  orgId: string,
  projectId: string,
  taskId: string,
  commentId: string,
  userId: string,
) {
  await requireVisibleTask(orgId, projectId, taskId);

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, taskId },
    select: { authorId: true },
  });
  if (!comment) throw new CommentNotFoundError();
  if (comment.authorId !== userId) throw new ForbiddenError('Only the author can delete a comment');

  // deleteMany, so a comment already deleted between the read above and here is a
  // no-op rather than a P2025 the error handler would answer as a 500.
  await prisma.comment.deleteMany({ where: { id: commentId } });
}
