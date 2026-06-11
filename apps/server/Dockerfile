# Build from the REPO ROOT (the workspace is the build context):
#   docker build -f apps/server/Dockerfile -t converge-server .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter "@converge/server..."
RUN pnpm --filter "@converge/crdt" build \
 && pnpm --filter "@converge/shared" build \
 && pnpm --filter "@converge/server" build
# Standalone deployable: server dist + migrations + prod node_modules
# with the workspace packages materialized.
RUN pnpm --filter "@converge/server" --prod deploy /out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out .
EXPOSE 8787
CMD ["node", "dist/index.js"]
