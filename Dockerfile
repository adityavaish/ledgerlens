# syntax=docker/dockerfile:1.7

# ─── Build stage ─────────────────────────────────────────────────────────
# Azure Linux 3.0 with Node.js 24 (no Node 22 variant is published; the app's
# `engines.node >=22` is satisfied). Pulled from MCR so we stay on a
# Microsoft-supported, vulnerability-patched base image.
FROM mcr.microsoft.com/azurelinux/base/nodejs:24 AS build
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
FROM mcr.microsoft.com/azurelinux/base/nodejs:24 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3002 \
    HOME=/home/nodejs \
    NPM_CONFIG_CACHE=/home/nodejs/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Run as non-root for App Service. The mcr.microsoft.com/azurelinux/base/nodejs
# image doesn't ship shadow-utils (no useradd/groupadd) and tdnf can't reach
# the Azure Linux package repos from ACR Tasks (GPG verification 403), so we
# create the nodejs user by writing passwd/group directly. ca-certificates,
# sed, install (coreutils) are present in the base image.
RUN echo "nodejs:x:1001:1001::/home/nodejs:/bin/sh" >> /etc/passwd \
 && echo "nodejs:x:1001:" >> /etc/group \
 && mkdir -p /home/nodejs/.copilot \
 && chown -R 1001:1001 /home/nodejs

COPY --from=build --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/dist          ./dist
COPY --from=build --chown=nodejs:nodejs /app/src/server    ./src/server
COPY --from=build --chown=nodejs:nodejs /app/server.js     ./server.js
COPY --from=build --chown=nodejs:nodejs /app/manifest.xml  ./manifest.xml
COPY --from=build --chown=nodejs:nodejs /app/package.json  ./package.json
COPY --from=build --chown=nodejs:nodejs /app/scripts/az-imds-shim.js ./scripts/az-imds-shim.js
COPY --from=build --chown=nodejs:nodejs /app/scripts/az-shim.sh      ./scripts/az-shim.sh

# Pre-install the Kusto MCP server so `npx -y @mcp-apps/kusto-mcp-server`
# (spawned by the runtime MCP stdio bridge) resolves instantly from the
# global prefix instead of fetching from the npm registry on first use —
# the registry fetch easily exceeds the MCP initialize-handshake timeout.
# We install globally as root, then hand the nodejs user a writable npm
# cache so `npx` doesn't EACCES on its tmp dir at runtime.
USER root
RUN npm install -g --no-audit --no-fund @mcp-apps/kusto-mcp-server@1.0.47 \
 && mkdir -p /home/nodejs/.npm \
 && chown -R nodejs:nodejs /home/nodejs/.npm
RUN install -m 0755 /app/scripts/az-shim.sh /usr/local/bin/az \
 && sed -i 's/\r$//' /usr/local/bin/az /app/scripts/az-imds-shim.js \
 && chmod +x /app/scripts/az-imds-shim.js
USER nodejs
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+ (process.env.PORT||3002) +'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
