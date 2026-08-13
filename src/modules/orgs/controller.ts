import type { FastifyReply, FastifyRequest } from 'fastify';
import * as orgService from './service.js';
import type { AddMemberInput, MemberRoleInput } from './service.js';

type MemberParams = { userId: string };

export async function create(
  request: FastifyRequest<{ Body: { name: string } }>,
  reply: FastifyReply,
) {
  const org = await orgService.createOrg(request.user.id, request.body.name);
  return reply.status(201).send(org);
}

export async function list(request: FastifyRequest, reply: FastifyReply) {
  return reply.send({ data: await orgService.listOrgs(request.user.id) });
}

export async function listMembers(request: FastifyRequest, reply: FastifyReply) {
  return reply.send({ data: await orgService.listMembers(request.org.id) });
}

export async function addMember(
  request: FastifyRequest<{ Body: AddMemberInput }>,
  reply: FastifyReply,
) {
  const member = await orgService.addMember(request.org.id, request.body);
  return reply.status(201).send(member);
}

export async function updateMemberRole(
  request: FastifyRequest<{ Params: MemberParams; Body: MemberRoleInput }>,
  reply: FastifyReply,
) {
  const member = await orgService.updateMemberRole(
    request.org.id,
    request.params.userId,
    request.body.role,
  );
  return reply.send(member);
}

export async function removeMember(
  request: FastifyRequest<{ Params: MemberParams }>,
  reply: FastifyReply,
) {
  await orgService.removeMember(request.org.id, request.params.userId);
  return reply.status(204).send();
}
