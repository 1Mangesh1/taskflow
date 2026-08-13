import { existsSync } from 'node:fs'
import { defineConfig, env } from 'prisma/config'

if (existsSync('.env')) process.loadEnvFile('.env')

type Env = {
  DATABASE_URL: string
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env<Env>('DATABASE_URL'),
  },
})
