import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OrgRole } from '../generated/prisma/client.js';
import { ForbiddenError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Set from the membership row itself, so services can never be handed an org id
    // that only ever existed in the request.
    org: { id: string; role: OrgRole };
  }

  interface FastifyInstance {
    requireOrgMember: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOrgAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function registerOrgContext(app: FastifyInstance) {
  app.decorate('requireOrgMember', async (request) => {
    const { orgId } = request.params as { orgId: string };
    // Checked here too, so a route that forgets `params: orgParams` still gets a 403
    // instead of sending a malformed id to a uuid column and failing with a 500.
    const membership = z.uuid().safeParse(orgId).success
      ? await prisma.orgMember.findUnique({
          where: { orgId_userId: { orgId, userId: request.user.id } },
          select: { orgId: true, role: true },
        })
      : null;
    // One answer for "not a member" and "no such org": a 404 here would let a caller
    // enumerate org ids.
    if (!membership) {
      throw new ForbiddenError('You do not have access to this organization');
    }

    request.org = { id: membership.orgId, role: membership.role };
  });

  app.decorate('requireOrgAdmin', async (request, reply) => {
    await app.requireOrgMember(request, reply);
    if (request.org.role !== 'org_admin') {
      throw new ForbiddenError('This action requires the org_admin role');
    }
  });
}
