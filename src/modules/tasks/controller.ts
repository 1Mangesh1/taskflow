import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TaskStatus } from '../../generated/prisma/client.js';
import type { Pagination } from '../../lib/pagination.js';
import { enqueueAssignmentEmail } from '../../lib/queue.js';
import * as taskService from './service.js';
import type { TaskInput, TaskListQuery, TaskPatch } from './service.js';

type ProjectParams = { projectId: string };
type TaskParams = ProjectParams & { taskId: string };
type AssigneeParams = TaskParams & { userId: string };

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

export async function assign(
  request: FastifyRequest<{ Params: TaskParams; Body: { userId: string } }>,
  reply: FastifyReply,
) {
  const { assignment, email } = await taskService.assignUser(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
    request.body.userId,
    request.user.id,
  );

  // Enqueued after the row is committed, and only enqueued: the caller never waits for
  // the mail to be sent. A Redis that is down costs the notification, not the
  // assignment, so the failure is logged and the 201 still goes out with no job id.
  const jobId = await enqueueAssignmentEmail(email).catch((err: unknown) => {
    request.log.error({ err }, 'failed to enqueue task-assigned email');
    return null;
  });

  return reply.status(201).send({ ...assignment, jobId });
}

export async function unassign(
  request: FastifyRequest<{ Params: AssigneeParams }>,
  reply: FastifyReply,
) {
  await taskService.unassignUser(
    request.org.id,
    request.params.projectId,
    request.params.taskId,
    request.params.userId,
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
