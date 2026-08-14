import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TaskStatus } from '../../generated/prisma/client.js';
import type { Pagination } from '../../lib/pagination.js';
import * as taskService from './service.js';
import type { TaskInput, TaskListQuery, TaskPatch } from './service.js';

type ProjectParams = { projectId: string };
type TaskParams = ProjectParams & { taskId: string };

export async function create(
  request: FastifyRequest<{ Params: ProjectParams; Body: TaskInput }>,
  reply: FastifyReply,
) {
  const task = await taskService.createTask(
    request.org.id,
    request.params.projectId,
    request.user.id,
    request.body,
  );
  return reply.status(201).send(task);
}

export async function list(
  request: FastifyRequest<{ Params: ProjectParams; Querystring: TaskListQuery }>,
  reply: FastifyReply,
) {
  return reply.send(
    await taskService.listTasks(request.org.id, request.params.projectId, request.query),
  );
}

export async function get(request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) {
  return reply.send(
    await taskService.getTask(request.org.id, request.params.projectId, request.params.taskId),
  );
}

export async function update(
  request: FastifyRequest<{ Params: TaskParams; Body: TaskPatch }>,
  reply: FastifyReply,
) {
  const task = await taskService.updateTask(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
    request.body,
  );
  return reply.send(task);
}

export async function remove(request: FastifyRequest<{ Params: TaskParams }>, reply: FastifyReply) {
  await taskService.softDeleteTask(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
  );
  return reply.status(204).send();
}

export async function bulkStatus(
  request: FastifyRequest<{ Body: { taskIds: string[]; status: TaskStatus } }>,
  reply: FastifyReply,
) {
  return reply.send(
    await taskService.bulkUpdateStatus(request.org.id, request.body.taskIds, request.body.status),
  );
}

export async function search(
  request: FastifyRequest<{ Querystring: Pagination & { q: string } }>,
  reply: FastifyReply,
) {
  return reply.send(await taskService.searchTasks(request.org.id, request.query.q, request.query));
}
