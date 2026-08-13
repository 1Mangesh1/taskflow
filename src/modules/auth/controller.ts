import type { FastifyReply, FastifyRequest } from 'fastify';
import * as authService from './service.js';
import type { LoginInput, RegisterInput } from './service.js';

type RefreshBody = { refreshToken: string };

export async function register(
  request: FastifyRequest<{ Body: RegisterInput }>,
  reply: FastifyReply,
) {
  const user = await authService.register(request.body);
  return reply.status(201).send({ user });
}

export async function login(request: FastifyRequest<{ Body: LoginInput }>, reply: FastifyReply) {
  const result = await authService.login(request.body, (userId) =>
    request.server.jwt.sign({ sub: userId }),
  );
  return reply.send(result);
}

export async function refresh(
  request: FastifyRequest<{ Body: RefreshBody }>,
  reply: FastifyReply,
) {
  const tokens = await authService.refresh(request.body.refreshToken, (userId) =>
    request.server.jwt.sign({ sub: userId }),
  );
  return reply.send(tokens);
}

export async function logout(request: FastifyRequest<{ Body: RefreshBody }>, reply: FastifyReply) {
  await authService.logout(request.body.refreshToken);
  return reply.status(204).send();
}

export async function logoutAll(request: FastifyRequest, reply: FastifyReply) {
  await authService.logoutAll(request.user.id);
  return reply.status(204).send();
}
