# syntax=docker/dockerfile:1.7

# ─── Build stage ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install all deps (incl. dev) for the webpack build.
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund

# Copy sources and build the production bundle.
COPY . .
RUN npm run build

# Strip dev deps to keep the runtime image lean.
RUN npm prune --omit=dev


# ─── Runtime stage ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3002 \
    HOME=/home/nodejs

# Run as non-root for App Service. Create a real home dir + .copilot dir
# so the Copilot CLI can write its config/state at runtime. Install
# ca-certificates so OpenSSL can load the trust store.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --create-home --home-dir /home/nodejs --shell /usr/sbin/nologin nodejs \
 && mkdir -p /home/nodejs/.copilot \
 && chown -R nodejs:nodejs /home/nodejs

COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/dist          ./dist
COPY --from=build --chown=nodejs:nodejs /app/src/server    ./src/server
COPY --from=build --chown=nodejs:nodejs /app/server.js     ./server.js
COPY --from=build --chown=nodejs:nodejs /app/package.json  ./package.json
COPY --from=build --chown=nodejs:nodejs /app/scripts/az-imds-shim.js ./scripts/az-imds-shim.js
COPY --from=build --chown=nodejs:nodejs /app/scripts/az-shim.sh      ./scripts/az-shim.sh

# Install the IMDS-backed `az` shim so kusto-mcp-server's AzureCliCredential
# can mint tokens via the App Service managed identity. This avoids shipping
# the full Azure CLI (~1 GB) in the container.
USER root
RUN install -m 0755 /app/scripts/az-shim.sh /usr/local/bin/az \
 && chmod +x /app/scripts/az-imds-shim.js
USER nodejs

USER nodejs
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3002) +'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
