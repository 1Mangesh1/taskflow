import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { UnauthorizedError } from '../lib/errors.js';

const ACCESS_TOKEN_TTL = '15m';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // No org id: org context is resolved per request from the database.
    payload: { sub: string };
    user: { id: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerAuth(app: FastifyInstance) {
  app.register(fastifyJwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: ACCESS_TOKEN_TTL },
    formatUser: (payload) => ({ id: payload.sub }),
  });

  app.decorate('authenticate', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError();
    }
  });
}
