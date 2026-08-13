import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcrypt'
import { PrismaClient } from '../src/generated/prisma/client.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

const days = (n: number) => new Date(Date.now() + n * 86_400_000)

async function main() {
  // Wipe in FK-safe order: org cascade clears all org-scoped rows (incl. tasks,
  // whose created_by RESTRICT would otherwise block user deletion).
  await prisma.organization.deleteMany()
  await prisma.user.deleteMany()

  const passwordHash = await bcrypt.hash('Password123!', 12)

  const acme = await prisma.organization.create({ data: { name: 'Acme Corp' } })
  const globex = await prisma.organization.create({ data: { name: 'Globex Labs' } })

  const [alice, ben, carla, dan, elena] = await Promise.all(
    [
      { email: 'alice.whitfield@acme-corp.example', name: 'Alice Whitfield' },
      { email: 'ben.okafor@acme-corp.example', name: 'Ben Okafor' },
      { email: 'carla.mendes@consulting.example', name: 'Carla Mendes' },
      { email: 'dan.novak@globex-labs.example', name: 'Dan Novak' },
      { email: 'elena.petrova@globex-labs.example', name: 'Elena Petrova' },
    ].map((u) => prisma.user.create({ data: { ...u, passwordHash } })),
  )

  const members = await prisma.orgMember.createMany({
    data: [
      { orgId: acme.id, userId: alice.id, role: 'org_admin' },
      { orgId: acme.id, userId: ben.id, role: 'member' },
      { orgId: acme.id, userId: carla.id, role: 'member' },
      { orgId: globex.id, userId: dan.id, role: 'org_admin' },
      // Carla belongs to both orgs (cross-tenant isolation test subject).
      { orgId: globex.id, userId: carla.id, role: 'member' },
      { orgId: globex.id, userId: elena.id, role: 'member' },
    ],
  })

  const website = await prisma.project.create({
    data: { orgId: acme.id, name: 'Website Redesign', description: 'Marketing site refresh for the Q4 launch' },
  })
  const mobile = await prisma.project.create({
    data: { orgId: acme.id, name: 'Mobile App', description: 'iOS and Android companion app' },
  })
  const pipeline = await prisma.project.create({
    data: { orgId: globex.id, name: 'Data Pipeline', description: 'Event ingestion and warehouse jobs' },
  })
  const legacy = await prisma.project.create({
    data: { orgId: acme.id, name: 'Legacy Portal', description: 'Retired customer portal', deletedAt: days(-30) },
  })

  const taskRows = [
    { projectId: website.id, orgId: acme.id, createdBy: alice.id, title: 'Design new landing page', description: 'Hero section, pricing table, and testimonials', status: 'in_progress', priority: 'high', dueDate: days(7) },
    { projectId: website.id, orgId: acme.id, createdBy: alice.id, title: 'Migrate blog to new CMS', description: 'Port articles and set up redirects', status: 'todo', priority: 'medium', dueDate: days(14) },
    { projectId: website.id, orgId: acme.id, createdBy: ben.id, title: 'Fix navigation dropdown on mobile', description: 'Menu closes immediately on tap', status: 'review', priority: 'urgent', dueDate: days(-2) },
    { projectId: website.id, orgId: acme.id, createdBy: ben.id, title: 'Update typography scale', status: 'done', priority: 'low' },
    { projectId: mobile.id, orgId: acme.id, createdBy: alice.id, title: 'Implement push notifications', description: 'APNs and FCM integration', status: 'in_progress', priority: 'urgent', dueDate: days(3) },
    { projectId: mobile.id, orgId: acme.id, createdBy: ben.id, title: 'Offline mode sync engine', description: 'Conflict resolution for queued edits', status: 'todo', priority: 'high', dueDate: days(30) },
    { projectId: mobile.id, orgId: acme.id, createdBy: carla.id, title: 'Fix crash on login screen', description: 'Null token dereference on cold start', status: 'done', priority: 'urgent', dueDate: days(-5) },
    { projectId: mobile.id, orgId: acme.id, createdBy: alice.id, title: 'Add biometric authentication', status: 'todo', priority: 'medium' },
    { projectId: pipeline.id, orgId: globex.id, createdBy: dan.id, title: 'Ingest customer events from Kafka', description: 'Backfill the last 90 days', status: 'in_progress', priority: 'high', dueDate: days(5) },
    { projectId: pipeline.id, orgId: globex.id, createdBy: elena.id, title: 'Deduplicate warehouse records', description: 'Same events arrive from two sources', status: 'todo', priority: 'medium', dueDate: days(-1) },
    { projectId: pipeline.id, orgId: globex.id, createdBy: dan.id, title: 'Nightly aggregation job', description: 'Roll up daily usage metrics', status: 'review', priority: 'low', dueDate: days(10) },
    { projectId: pipeline.id, orgId: globex.id, createdBy: carla.id, title: 'Archive stale datasets', description: 'Move cold partitions to object storage', status: 'done', priority: 'low', deletedAt: days(-3) },
  ] as const

  const tasks = []
  for (const t of taskRows) tasks.push(await prisma.task.create({ data: t }))

  const assignments = await prisma.taskAssignment.createMany({
    data: [
      { taskId: tasks[0].id, userId: ben.id, assignedBy: alice.id },
      { taskId: tasks[0].id, userId: carla.id, assignedBy: alice.id },
      { taskId: tasks[2].id, userId: carla.id, assignedBy: alice.id },
      { taskId: tasks[4].id, userId: alice.id, assignedBy: alice.id },
      { taskId: tasks[8].id, userId: elena.id, assignedBy: dan.id },
      { taskId: tasks[9].id, userId: carla.id, assignedBy: dan.id },
      { taskId: tasks[10].id, userId: elena.id, assignedBy: dan.id },
    ],
  })

  const comments = await prisma.comment.createMany({
    data: [
      { taskId: tasks[0].id, authorId: alice.id, body: 'Wireframes are approved, please use the v2 color palette.' },
      { taskId: tasks[0].id, authorId: ben.id, body: 'Hero section is done, starting on the pricing table.' },
      { taskId: tasks[2].id, authorId: carla.id, body: 'Reproduced on iOS Safari, looks like a z-index issue.' },
      { taskId: tasks[4].id, authorId: alice.id, body: 'FCM keys are in the shared vault.' },
      { taskId: tasks[6].id, authorId: carla.id, body: 'Fixed by guarding the token read, shipped in 1.4.2.' },
      { taskId: tasks[8].id, authorId: elena.id, body: 'Kafka topic naming is confirmed with the platform team.' },
    ],
  })

  console.log(
    `Seeded 2 orgs, 5 users, ${members.count} memberships, 4 projects, ${tasks.length} tasks, ${assignments.count} assignments, ${comments.count} comments`,
  )
}

try {
  await main()
} finally {
  await prisma.$disconnect()
}
