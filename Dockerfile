# Node 24 is the current active LTS line. Alpine is safe here because bcrypt, the only
# native dependency, ships a musl prebuild for linux-x64 and linux-arm64, so no image in
# this file needs a compiler.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
# src/generated/prisma is gitignored, so the client has to be generated here before tsc
# has anything to compile against. prisma.config.ts resolves the datasource url eagerly,
# so generate needs a DATABASE_URL to be set even though it never opens a connection.
# The prune leaves the production set for the runtime stage, which is why the prisma CLI
# is a runtime dependency: the api container applies migrations on start.
RUN DATABASE_URL=postgresql://unused:unused@localhost:5432/unused npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# prisma.config.ts carries the datasource url: schema.prisma has no url of its own, so
# migrate deploy needs both files.
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
