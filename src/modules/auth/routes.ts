import rateLimit from '@fastify/rate-limit';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { RateLimitError } from '../../lib/errors.js';
import * as controller from './controller.js';

const userResponse = z.object({ id: z.uuid(), email: z.email(), name: z.string() });
const tokensResponse = z.object({ accessToken: z.string(), refreshToken: z.string() });
const refreshTokenBody = z.object({ refreshToken: z.string().min(1) });
// bcrypt reads at most 72 bytes, so a longer password and its 72-byte prefix hash
// alike. The bound is in bytes because that is what bcrypt counts.
const password = z
  .string()
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes');

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // Registered inside this plugin so the limiter covers the auth routes only.
  await app.register(rateLimit, {
    max: 10,
    timeWindow: '1 minute',
    errorResponseBuilder: () => new RateLimitError(),
  });

  app.post(
    '/register',
    {
      schema: {
        tags: ['auth'],
        summary: 'Register a user',
        security: [],
        errors: [400, 409],
        body: z.object({
          email: z.email(),
          password: password.min(8),
          name: z.string().min(1),
        }),
        response: { 201: z.object({ user: userResponse }) },
      },
    },
    controller.register,
  );

  app.post(
    '/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log in and receive an access and a refresh token',
        security: [],
        errors: [400, 401],
        body: z.object({ email: z.email(), password: password.min(1) }),
        response: { 200: tokensResponse.extend({ user: userResponse }) },
      },
    },
    controller.login,
  );

  app.post(
    '/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new pair, revoking the old one',
        security: [],
        errors: [400, 401],
        body: refreshTokenBody,
        response: { 200: tokensResponse },
      },
    },
    controller.refresh,
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke one refresh token',
        security: [],
        errors: [400],
        body: refreshTokenBody,
      },
    },
    controller.logout,
  );

  app.post(
    '/logout-all',
    {
      onRequest: app.authenticate,
      schema: {
        tags: ['auth'],
        summary: 'Revoke every refresh token the caller holds',
        errors: [401],
      },
    },
    controller.logoutAll,
  );
};
