import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  // HS256 keys shorter than the 256-bit hash output weaken the signature.
  JWT_SECRET: z.string().min(32),
  // On by default so the API always ships its own reference. A deployment that does not
  // want the schema and the try-it-out console reachable turns it off here.
  DOCS_ENABLED: z.stringbool().default(true),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  process.exit(1);
}

export const config = parsed.data;
