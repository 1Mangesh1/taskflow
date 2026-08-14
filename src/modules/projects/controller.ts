import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pagination } from '../../lib/pagination.js';
import * as projectService from './service.js';
import type { ProjectInput, ProjectPatch } from './service.js';

type ProjectParams = { projectId: string };

export async function create(
  request: FastifyRequest<{ Body: ProjectInput }>,
  reply: FastifyReply,
) {
  const project = await projectService.createProject(request.org.id, request.body);
  return reply.status(201).send(project);
}

export async function list(
  request: FastifyRequest<{ Querystring: Pagination }>,
  reply: FastifyReply,
) {
  return reply.send(await projectService.listProjects(request.org.id, request.query));
}

export async function get(request: FastifyRequest<{ Params: ProjectParams }>, reply: FastifyReply) {
  return reply.send(await projectService.getProject(request.org.id, request.params.projectId));
}

export async function update(
  request: FastifyRequest<{ Params: ProjectParams; Body: ProjectPatch }>,
  reply: FastifyReply,
) {
  const project = await projectService.updateProject(
    request.org.id,
    request.params.projectId,
    request.body,
  );
  return reply.send(project);
}

export async function remove(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  await projectService.softDeleteProject(request.org.id, request.params.projectId);
  return reply.status(204).send();
}

export async function dashboard(
  request: FastifyRequest<{ Params: ProjectParams }>,
  reply: FastifyReply,
) {
  return reply.send(
    await projectService.projectDashboard(request.org.id, request.params.projectId),
  );
}
