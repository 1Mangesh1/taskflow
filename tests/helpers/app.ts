import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

// A fresh instance per test keeps the in-memory rate limiter isolated.
export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}

// Tokens are signed with the app's own key rather than obtained through
// /api/auth/login: logging in would cost a bcrypt hash per user and most of the auth
// rate limit budget.
export const asUser = (app: FastifyInstance, userId: string) => ({
  authorization: `Bearer ${app.jwt.sign({ sub: userId })}`,
});

export const createOrg = (app: FastifyInstance, userId: string, name: string) =>
  app
    .inject({ method: 'POST', url: '/api/orgs', headers: asUser(app, userId), body: { name } })
    .then((res) => res.json<{ id: string }>());

export const createProject = (app: FastifyInstance, orgId: string, userId: string, name: string) =>
  app
    .inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/projects`,
      headers: asUser(app, userId),
      body: { name },
    })
    .then((res) => res.json<{ id: string }>());

export const addMember = (app: FastifyInstance, orgId: string, adminId: string, email: string) =>
  app.inject({
    method: 'POST',
    url: `/api/orgs/${orgId}/members`,
    headers: asUser(app, adminId),
    body: { email, role: 'member' },
  });

export const createTask = (
  app: FastifyInstance,
  orgId: string,
  projectId: string,
  userId: string,
  title: string,
) =>
  app
    .inject({
      method: 'POST',
      url: `/api/orgs/${orgId}/projects/${projectId}/tasks`,
      headers: asUser(app, userId),
      body: { title },
    })
    .then((res) => res.json<{ id: string }>());
