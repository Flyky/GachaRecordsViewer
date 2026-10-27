FROM node:24.22.1-bookworm AS dependency-base
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/gacha-core/package.json ./packages/gacha-core/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/uigf/package.json ./packages/uigf/package.json

FROM dependency-base AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm build

FROM dependency-base AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM node:24.22.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 GRV_DATA_DIR=/app/data
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/server/package.json ./apps/server/package.json
COPY --from=production-dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies /app/packages ./packages
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/gacha-core/dist ./packages/gacha-core/dist
COPY --from=build /app/packages/providers/dist ./packages/providers/dist
COPY --from=build /app/packages/uigf/dist ./packages/uigf/dist
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY LICENSE ./LICENSE
COPY packages/gacha-core/METADATA_LICENSE ./licenses/METADATA_LICENSE
COPY packages/uigf/SCHEMA_LICENSE ./licenses/SCHEMA_LICENSE
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/server/dist/index.js", "--serve-web"]
