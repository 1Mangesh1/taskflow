import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pagination } from '../../lib/pagination.js';
import * as commentService from './service.js';

type TaskParams = { projectId: string; taskId: string };
type CommentParams = TaskParams & { commentId: string };

export async function create(
  request: FastifyRequest<{ Params: TaskParams; Body: { body: string } }>,
  reply: FastifyReply,
) {
  const comment = await commentService.createComment(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
    request.user.id,
    request.body.body,
  );
  return reply.status(201).send(comment);
}

export async function list(
  request: FastifyRequest<{ Params: TaskParams; Querystring: Pagination }>,
  reply: FastifyReply,
) {
  return reply.send(
    await commentService.listComments(
      request.org.id,
      request.params.projectId,
      request.params.taskId,
      request.query,
    ),
  );
}

export async function remove(
  request: FastifyRequest<{ Params: CommentParams }>,
  reply: FastifyReply,
) {
  await commentService.deleteComment(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
    request.params.commentId,
    request.user.id,
  );
  return reply.status(204).send();
}
