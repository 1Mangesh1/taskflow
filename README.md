# TaskFlow

Backend for a lightweight project management system: users belong to organizations, create projects,
manage tasks, assign work to teammates, and receive email notifications processed in the background.

Every request is scoped to a single organization, and that scope is resolved from the database on each
request rather than taken from the caller, so one tenant cannot reach another tenant's data.

## Stack

| Component | Choice |
| :--- | :--- |
| Runtime | Node.js 24 (Alpine in Docker) |
| API | Fastify 5 with `fastify-type-provider-zod` 7 |
| Validation | Zod 4 |
| Database | PostgreSQL 17 |
| ORM / migrations | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Queue | Redis 7 with BullMQ 6 |
| Auth | `@fastify/jwt` 10, bcrypt 6 |
| Tests | Vitest 4 with V8 coverage |

## Quickstart (Docker)

```bash
git clone <repo-url> && cd taskflow
cp .env.example .env
# JWT_SECRET has no default and must be at least 32 characters:
printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
# Inside compose, containers reach each other by service name, not through the host loopback:
#   DATABASE_URL=postgresql://taskflow:taskflow@postgres:5432/taskflow
#   REDIS_URL=redis://redis:6379
docker compose up --build -d
docker compose exec api npm run db:seed
open http://localhost:3000/docs
```

`docker compose up` starts four services: `api`, `worker`, `postgres`, `redis`. The API container runs
`prisma migrate deploy` before starting, so a fresh volume gets the schema automatically.

## Quickstart (local, without Docker for the app)

```bash
docker compose up -d postgres redis   # database and queue only
cp .env.example .env                  # then set JWT_SECRET as above
npm install
npx prisma generate                   # required: the generated client is gitignored
npm run db:migrate
npm run db:seed
npm run dev                           # API on :3000
npm run dev:worker                    # worker, in a second terminal
```

`npx prisma generate` is not optional on a fresh clone. The Prisma client is generated into
`src/generated/prisma`, which is deliberately not committed, so building or testing before generating
it will fail.

## Environment variables

| Variable | Purpose | Example | Required |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Runtime mode | `development` | No |
| `PORT` | API listen port | `3000` (default) | No |
| `DATABASE_URL` | Postgres connection | `postgresql://taskflow:taskflow@localhost:5432/taskflow` | Yes |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` | Yes |
| `JWT_SECRET` | Access-token signing key, minimum 32 characters | generate with `openssl rand -hex 32` | Yes |
| `TEST_DATABASE_URL` | Database used by the test suite | `postgresql://taskflow:taskflow@localhost:5432/taskflow_test` | For tests |
| `TEST_REDIS_URL` | Redis database index used by tests | `redis://localhost:6379/1` | For tests |
| `DOCS_ENABLED` | Serves Swagger UI and the OpenAPI document | `true` (default) | No |

Host-facing values use `localhost`; Compose overrides `DATABASE_URL` and `REDIS_URL` with the service
names `postgres` and `redis`, because one container cannot reach another through the host's loopback
interface. `.env` is gitignored and `.env.example` ships with an empty `JWT_SECRET` on purpose: an
empty value fails validation at boot, so a checkout cannot run on a secret published in this repo.

## Seeded data

Seeding creates 2 organizations, 5 users, 4 projects, 12 tasks, 7 assignments, and 6 comments. Tasks
cover all four statuses and all four priorities, and one project and one task are soft-deleted so the
filtering is visible. Every seeded user has the password `Password123!`.

| Email | Organization | Role |
| :--- | :--- | :--- |
| alice.whitfield@acme-corp.example | Acme Corp | org_admin |
| ben.okafor@acme-corp.example | Acme Corp | member |
| carla.mendes@consulting.example | Acme Corp **and** Globex Labs | member in both |
| dan.novak@globex-labs.example | Globex Labs | org_admin |
| elena.petrova@globex-labs.example | Globex Labs | member |

Carla belongs to both organizations, which makes cross-tenant behavior testable with a real account
rather than a synthetic one.

## API documentation

- Swagger UI: <http://localhost:3000/docs>
- OpenAPI document: <http://localhost:3000/docs/json>
- Postman collection: `docs/TaskFlow.postman_collection.json`

The OpenAPI document is generated from the same Zod schemas the routes validate against, so it cannot
drift from the implementation. The collection runs top to bottom against a running stack with no
environment file and no manual edits:

```bash
npx newman run docs/TaskFlow.postman_collection.json
```

## Endpoints

```
POST   /api/auth/register                          POST   /api/auth/login
POST   /api/auth/refresh                           POST   /api/auth/logout
POST   /api/auth/logout-all

GET    /api/orgs                                   POST   /api/orgs
GET    /api/orgs/:orgId/members                    POST   /api/orgs/:orgId/members
PATCH  /api/orgs/:orgId/members/:userId            DELETE /api/orgs/:orgId/members/:userId

GET    /api/orgs/:orgId/projects                   POST   /api/orgs/:orgId/projects
GET    /api/orgs/:orgId/projects/:projectId        PATCH  /api/orgs/:orgId/projects/:projectId
DELETE /api/orgs/:orgId/projects/:projectId        GET    /api/orgs/:orgId/projects/:projectId/dashboard

GET    /api/orgs/:orgId/projects/:projectId/tasks  POST   /api/orgs/:orgId/projects/:projectId/tasks
GET    .../tasks/:taskId                           PATCH  .../tasks/:taskId
DELETE .../tasks/:taskId
POST   .../tasks/:taskId/assignees                 DELETE .../tasks/:taskId/assignees/:userId
GET    .../tasks/:taskId/comments                  POST   .../tasks/:taskId/comments
DELETE .../tasks/:taskId/comments/:commentId

POST   /api/orgs/:orgId/tasks/bulk-status          GET    /api/orgs/:orgId/tasks/search
GET    /api/jobs/:id                               GET    /health
```

List endpoints answer with `{ "data": [], "total": 0, "page": 1, "limit": 20 }`. Every handled failure
answers with `{ "error": "Task not found", "code": "TASK_NOT_FOUND", "details": {} }`.

## Deploying to Render

`render.yaml` is a Blueprint: point Render at this repo (New > Blueprint) and it creates the
API web service, a free Postgres database, and a free Key Value instance for the queue,
generating `JWT_SECRET` itself. Migrations run on every deploy via `prisma migrate deploy`.
Seed the demo data once from the service shell with `npx prisma db seed`.

Two constraints of the free plan shape this blueprint:

- **No background workers.** They start at the paid tier, so `RUN_WORKER=true` makes the API
  process consume the queue as well. Compose still runs the two processes separately, which
  is the arrangement to use anywhere with room for it.
- **Free Postgres expires 30 days after creation** (then a 14-day grace period). For a
  long-lived demo, point `DATABASE_URL` at an external free Postgres such as Neon and
  `REDIS_URL` at an external Redis such as Upstash, and delete the `databases` block and
  the `keyvalue` service from the blueprint. Render's free Key Value is in-memory only and
  loses queued jobs on restart, which is the other reason to move it.

Free web services also sleep after 15 minutes of inactivity, so the first request afterwards
waits about a minute for the cold start. An uptime monitor pinging `/health` every 5 minutes
keeps it warm within the 750 free instance-hours a month.

The browser console is hosted separately on GitHub Pages and calls the API cross-origin, so
`CORS_ORIGINS` must list that origin exactly. Leave it empty when using the copy the API
serves at `/ui`.

## Testing

```bash
npm run test:setup      # creates taskflow_test and applies migrations
npm test                # 113 tests across 19 files
npm run test:coverage   # terminal summary plus an HTML report under coverage/
npm run typecheck       # typechecks src and tests
```

Tests run against a real Postgres database (`TEST_DATABASE_URL`, a separate database from development)
and a real Redis database index (`redis://localhost:6379/1`), never against the development data.
Tables are truncated between tests, and queue tests read jobs back off a real BullMQ queue rather than
mocking it. Nothing first-party is mocked.

Coverage at the last run: 95.46% of statements, 85.71% of branches, 96.06% of lines.

## Design decisions

**Tenant isolation.** The access token carries only a user id. Organization context is resolved per
request by looking up the caller's `org_members` row for the `:orgId` in the path; a non-member gets
403 whether or not the organization exists, so probing cannot distinguish "not yours" from "no such
org". Every org-scoped route is registered inside a child plugin that installs the membership guard as
a scope-level hook, which makes it structurally impossible for a new route to forget the check. Every
service takes `orgId` as an explicit argument and filters on it; no service accepts an organization id
from a request body.

**Foreign keys.** Organization-owned rows (`org_members`, `projects`, `tasks`) cascade: deleting an
organization removes its tenant data. Task children (`task_assignments`, `comments`) cascade with their
task. Authorship columns (`tasks.created_by`, `comments.author_id`, `task_assignments.assigned_by`) are
`RESTRICT`, so a user who left a trail cannot be silently deleted out from under it. Refresh tokens
cascade with their user, because a deleted user's sessions have no meaning.

**Denormalized `tasks.org_id`.** Tasks carry the organization id directly so every task query can
filter by tenant without joining through projects. The invariant is that it always equals the parent
project's `org_id`; the service layer derives it from the verified project row and never from input.
Prisma cannot model the composite foreign key that would enforce this at the database level, so it is
documented and enforced in one place instead.

**Soft delete.** Projects and tasks set `deleted_at` rather than being removed. Deleting a project does
*not* cascade a soft delete to its tasks: the project filter already hides them, and cascading would
mean an unbounded write on delete. Task queries therefore exclude both their own `deleted_at` and any
task whose parent project is soft-deleted.

**Tokens.** Access tokens live 15 minutes. Refresh tokens are 256 random bits, returned once and stored
only as a SHA-256 hash, and they rotate on use: presenting one revokes it and issues a replacement, so
a replayed token is rejected. Rotation runs in a transaction with a conditional update, which makes it
single-use even under concurrent refreshes. Passwords are bcrypt-hashed with cost 12 and bounded at 72
UTF-8 bytes, the point where bcrypt truncates.

**Migrations.** Prisma does not generate down migrations. Rolling back locally means `npm run db:reset`,
which drops, re-applies, and re-seeds. This is a deliberate acceptance of Prisma's model rather than a
hand-maintained pair of up/down scripts that would drift.

**Background jobs.** Assignment writes the row, then enqueues the notification without awaiting it. If
Redis is unreachable the assignment still succeeds and returns `jobId: null`, because a broken queue
should not break task assignment. Jobs retry 3 times with exponential backoff, and a job that exhausts
its attempts is copied to an `email-dlq` queue with its failure reason. Repeat assignments of the same
task and user inside 5 seconds are deduplicated into one job.

**Retry schedule.** Three attempts produce two gaps, measured at 1.00s and 1.99s against real Redis.
The brief describes "1s to 2s to 4s"; a 4s gap would require a fourth attempt, which contradicts
"retry failed jobs 3 times", so the attempt count was kept at 3.

## Known limitations

- Rate limiting is 10 requests per minute per IP on the auth routes only, as the brief specifies. The
  store is in-process, so the budget is per API instance rather than global.
- The dead-letter queue has no drainer. Failed payloads accumulate there as an operator record and are
  removed manually.
- Swagger UI is enabled by default so the API is explorable out of the box. Set `DOCS_ENABLED=false` to
  turn it off.
- Expired refresh tokens are never pruned from the database.
- The rate limiter keys on the socket address, so behind a proxy every client would collapse into one
  bucket unless `trustProxy` is configured.
