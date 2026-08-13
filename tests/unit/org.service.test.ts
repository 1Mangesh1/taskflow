import { beforeEach, expect, test } from 'vitest';
import * as orgService from '../../src/modules/orgs/service.js';
import { createUser, prisma, truncateAll } from '../helpers/db.js';

const ALICE = ['alice.navarro@acme-corp.example', 'Alice Navarro'] as const;
const BEN = ['ben.okafor@acme-corp.example', 'Ben Okafor'] as const;

beforeEach(truncateAll);

test('creating an org makes the creator its only member, as admin', async () => {
  const creator = await createUser(...ALICE);

  const org = await orgService.createOrg(creator.id, 'Acme Corp');

  expect(org).toEqual({ id: expect.any(String), name: 'Acme Corp', role: 'org_admin' });
  const members = await prisma.orgMember.findMany({ where: { orgId: org.id } });
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({ userId: creator.id, role: 'org_admin' });
});

test('the last admin cannot be demoted, a second admin unblocks it', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const org = await orgService.createOrg(alice.id, 'Acme Corp');
  await orgService.addMember(org.id, { email: ben.email, role: 'member' });

  await expect(orgService.updateMemberRole(org.id, alice.id, 'member')).rejects.toMatchObject({
    code: 'LAST_ADMIN',
  });

  await orgService.updateMemberRole(org.id, ben.id, 'org_admin');
  expect(await orgService.updateMemberRole(org.id, alice.id, 'member')).toEqual({
    userId: alice.id,
    role: 'member',
  });
});

test('the last admin cannot be removed, a second admin unblocks it', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const org = await orgService.createOrg(alice.id, 'Acme Corp');
  await orgService.addMember(org.id, { email: ben.email, role: 'member' });

  await expect(orgService.removeMember(org.id, alice.id)).rejects.toMatchObject({
    code: 'LAST_ADMIN',
  });

  await orgService.updateMemberRole(org.id, ben.id, 'org_admin');
  await orgService.removeMember(org.id, alice.id);

  expect(await orgService.listMembers(org.id)).toEqual([
    {
      userId: ben.id,
      email: ben.email,
      name: ben.name,
      role: 'org_admin',
      joinedAt: expect.any(Date),
    },
  ]);
});

// Both demotions read the same two admins; without the row lock in the service both
// commit and the org is left with none. Ten independent pairs rather than one: a
// single pair often does not interleave on a warm database, and would let a missing
// lock pass unnoticed.
test('two admins demoted at the same time cannot both succeed', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const orgs = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const org = await orgService.createOrg(alice.id, `Acme Corp ${index + 1}`);
      await orgService.addMember(org.id, { email: ben.email, role: 'org_admin' });
      return org;
    }),
  );

  const results = await Promise.allSettled(
    orgs.flatMap((org) => [
      orgService.updateMemberRole(org.id, alice.id, 'member'),
      orgService.updateMemberRole(org.id, ben.id, 'member'),
    ]),
  );

  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(10);
  const admins = await prisma.orgMember.findMany({
    where: { role: 'org_admin' },
    select: { orgId: true },
  });
  expect(admins.map((admin) => admin.orgId).sort()).toEqual(orgs.map((org) => org.id).sort());
});

test('removing a member of another org reports the member as unknown', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const acme = await orgService.createOrg(alice.id, 'Acme Corp');
  await orgService.createOrg(ben.id, 'Globex');

  await expect(orgService.removeMember(acme.id, ben.id)).rejects.toMatchObject({
    code: 'MEMBER_NOT_FOUND',
  });
});

test('a member can only be added once, and only if registered', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const org = await orgService.createOrg(alice.id, 'Acme Corp');

  await expect(
    orgService.addMember(org.id, { email: 'ghost.harper@acme-corp.example', role: 'member' }),
  ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });

  expect(await orgService.addMember(org.id, { email: ben.email, role: 'member' })).toEqual({
    userId: ben.id,
    email: ben.email,
    name: ben.name,
    role: 'member',
  });

  await expect(
    orgService.addMember(org.id, { email: ben.email, role: 'org_admin' }),
  ).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });
});

test('listing orgs returns only the ones the user belongs to, with their role there', async () => {
  const alice = await createUser(...ALICE);
  const ben = await createUser(...BEN);
  const acme = await orgService.createOrg(alice.id, 'Acme Corp');
  const globex = await orgService.createOrg(ben.id, 'Globex');
  await orgService.addMember(globex.id, { email: alice.email, role: 'member' });

  expect(await orgService.listOrgs(alice.id)).toEqual([
    { id: acme.id, name: 'Acme Corp', role: 'org_admin' },
    { id: globex.id, name: 'Globex', role: 'member' },
  ]);
  expect(await orgService.listOrgs(ben.id)).toEqual([
    { id: globex.id, name: 'Globex', role: 'org_admin' },
  ]);
});
