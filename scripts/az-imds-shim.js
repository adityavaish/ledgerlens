#!/usr/bin/env node
/**
 * Minimal `az` CLI shim that implements only `az account get-access-token`
 * by calling the App Service Managed Identity IMDS endpoint. The MCP-based
 * Kusto server uses AzureCliCredential, which spawns `az account
 * get-access-token`; this shim lets that work inside an App Service
 * container without installing the full Azure CLI (~1 GB).
 *
 * Supported invocation (matches @azure/identity v4 contract):
 *   az account get-access-token --output json [--scope <SCOPE>] [--resource <RES>]
 *
 * All other subcommands exit non-zero with a clear message so misuse is
 * obvious. The shim purposely does NOT try to be a general az replacement.
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out.positional.push(token);
    }
  }
  return out;
}

function fail(message, code = 1) {
  process.stderr.write(`az-imds-shim: ${message}\n`);
  process.exit(code);
}

function resourceFromScope(scope) {
  if (!scope) return null;
  return scope.endsWith("/.default") ? scope.slice(0, -"/.default".length) : scope;
}

function requestJson(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(new Error(`Invalid JSON from IMDS: ${err.message} :: ${body.slice(0, 200)}`));
            }
          } else {
            reject(new Error(`IMDS responded ${res.statusCode}: ${body.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("IMDS request timed out")));
    req.end();
  });
}

async function getAccessToken(args) {
  const resource = args.flags.resource || resourceFromScope(args.flags.scope) || "https://management.azure.com";

  // ── User-delegated token override ──────────────────────────────────────
  // If a pinned-token file is configured (set per-spawn by the MCP stdio
  // proxy), the upstream code is forwarding the signed-in user's token. Use
  // it verbatim instead of minting an MI token via IMDS. The file holds
  // `{ accessToken, expiresOn, tenant?, subscription? }`.
  const pinnedFile = process.env.LEDGERLENS_PINNED_TOKEN_FILE;
  if (pinnedFile) {
    try {
      const raw = fs.readFileSync(pinnedFile, "utf8");
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.accessToken) {
          return {
            accessToken: parsed.accessToken,
            expiresOn: parsed.expiresOn || "",
            expires_on: parsed.expires_on || undefined,
            subscription: parsed.subscription || "",
            tenant: parsed.tenant || process.env.AZURE_TENANT_ID || "",
            tokenType: parsed.tokenType || "Bearer",
          };
        }
      }
    } catch (err) {
      // If the file exists but is unreadable / malformed, surface the error
      // instead of silently falling through to MI auth — otherwise we'd
      // serve the wrong identity to the data plane.
      throw new Error(`pinned token file unreadable: ${err.message}`);
    }
  }

  const identityEndpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;
  const imdsEndpoint = process.env.MSI_ENDPOINT;
  const clientId = process.env.AZURE_CLIENT_ID;

  let target;
  let headers;
  if (identityEndpoint && identityHeader) {
    // App Service / Functions / Container Apps MI endpoint.
    const url = new URL(identityEndpoint);
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", "2019-08-01");
    if (clientId) url.searchParams.set("client_id", clientId);
    target = url.toString();
    headers = { "X-IDENTITY-HEADER": identityHeader };
  } else if (imdsEndpoint) {
    // Legacy MSI endpoint (some flavours of App Service).
    const url = new URL(imdsEndpoint);
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", "2017-09-01");
    if (clientId) url.searchParams.set("clientid", clientId);
    target = url.toString();
    headers = { Secret: process.env.MSI_SECRET || "" };
  } else {
    // Azure VM IMDS fallback.
    const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
    url.searchParams.set("resource", resource);
    url.searchParams.set("api-version", "2018-02-01");
    if (clientId) url.searchParams.set("client_id", clientId);
    target = url.toString();
    headers = { Metadata: "true" };
  }

  const payload = await requestJson(target, headers);

  const accessToken = payload.access_token || payload.accessToken;
  if (!accessToken) {
    throw new Error(`IMDS response missing access_token: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const expiresOnSec = Number(payload.expires_on || payload.expiresOn || 0);
  const expiresOnDate = new Date(expiresOnSec * 1000);
  const expiresOnIso = isFinite(expiresOnDate.getTime())
    ? expiresOnDate.toISOString().replace("T", " ").replace("Z", ".000000")
    : "";

  return {
    accessToken,
    expiresOn: expiresOnIso,
    expires_on: expiresOnSec || undefined,
    subscription: payload.subscription || "",
    tenant: payload.tenant || process.env.AZURE_TENANT_ID || "",
    tokenType: payload.token_type || payload.tokenType || "Bearer",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  const [group, command] = args.positional;
  if (group === "account" && command === "get-access-token") {
    try {
      const result = await getAccessToken(args);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (err) {
      fail(`get-access-token failed: ${err.message}`);
    }
  } else if (group === "version" || args.flags.version) {
    process.stdout.write(
      JSON.stringify({ "azure-cli": "0.0.0-ledgerlens-shim", shim: true })
    );
    process.exit(0);
  } else {
    fail(`unsupported command: ${argv.join(" ")}`, 2);
  }
}

main();
