import { Prisma, type OrgRole } from '../../generated/prisma/client.js';
import {
  AlreadyMemberError,
  LastAdminError,
  MemberNotFoundError,
  UserNotFoundError,
} from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';

export type AddMemberInput = { email: string; role: OrgRole };
export type MemberRoleInput = { role: OrgRole };

// Locks the org's admin rows for the rest of the transaction. Two concurrent
// demotions would otherwise each see the other admin and leave the org with none;
// under FOR UPDATE the second one re-reads after the first commits.
const lockAdmins = (tx: Prisma.TransactionClient, orgId: string) =>
  tx.$queryRaw<{ user_id: string }[]>`
    SELECT user_id FROM org_members
    WHERE org_id = ${orgId}::uuid AND role = 'org_admin'
    FOR UPDATE`;

export async function createOrg(userId: string, name: string) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name }, select: { id: true, name: true } });
    await tx.orgMember.create({ data: { orgId: org.id, userId, role: 'org_admin' } });
    return { ...org, role: 'org_admin' as const };
  });
}

export async function listOrgs(userId: string) {
  const memberships = await prisma.orgMember.findMany({
    where: { userId },
    select: { role: true, org: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map(({ org, role }) => ({ id: org.id, name: org.name, role }));
}

export async function listMembers(orgId: string) {
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    select: {
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return members.map((member) => ({
    userId: member.userId,
    email: member.user.email,
    name: member.user.name,
    role: member.role,
    joinedAt: member.createdAt,
  }));
}

export async function addMember(orgId: string, input: AddMemberInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
    select: { id: true, email: true, name: true },
  });
  if (!user) throw new UserNotFoundError();

  try {
    await prisma.orgMember.create({ data: { orgId, userId: user.id, role: input.role } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AlreadyMemberError();
    }
    throw err;
  }

  return { userId: user.id, email: user.email, name: user.name, role: input.role };
}

export async function updateMemberRole(orgId: string, userId: string, role: OrgRole) {
  return prisma.$transaction(async (tx) => {
    const admins = await lockAdmins(tx, orgId);
    const member = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    if (!member) throw new MemberNotFoundError();
    if (member.role === 'org_admin' && role !== 'org_admin' && admins.length === 1) {
      throw new LastAdminError();
    }

    await tx.orgMember.update({ where: { orgId_userId: { orgId, userId } }, data: { role } });
    return { userId, role };
  });
}

export async function removeMember(orgId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const admins = await lockAdmins(tx, orgId);
    const member = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });
    if (!member) throw new MemberNotFoundError();
    if (member.role === 'org_admin' && admins.length === 1) throw new LastAdminError();

    await tx.orgMember.delete({ where: { orgId_userId: { orgId, userId } } });
  });
}
