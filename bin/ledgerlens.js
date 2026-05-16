#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const https = require("https");
const { spawn, spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const zlib = require("zlib");

const REPO = "adityavaish/ledgerlens";
const RELEASES_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
const USER_AGENT = "ledgerlens-launcher";

function log(...args) { console.log("[ledgerlens]", ...args); }
function warn(...args) { console.warn("[ledgerlens]", ...args); }

function getInstallDir() {
  if (process.env.LEDGERLENS_HOME) return process.env.LEDGERLENS_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "ledgerlens");
  return path.join(os.homedir(), ".ledgerlens");
}

function loadCurrent(installDir) {
  try { return JSON.parse(fs.readFileSync(path.join(installDir, "current.json"), "utf8")); } catch { return null; }
}
function saveCurrent(installDir, payload) {
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "current.json"), JSON.stringify(payload, null, 2));
}
function semverGt(a, b) {
  const norm = (s) => String(s).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const A = norm(a), B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return resolve(httpsGetJson(res.headers.location));
      if (res.statusCode !== 200) return reject(new Error("GitHub API " + res.statusCode + ": " + url));
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    }).on("error", reject);
  });
}
function httpsDownload(url, outPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream" } }, async (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return resolve(httpsDownload(res.headers.location, outPath));
      if (res.statusCode !== 200) return reject(new Error("Download " + res.statusCode + ": " + url));
      const out = fs.createWriteStream(outPath);
      try { await pipeline(res, out); resolve(); } catch (err) { reject(err); }
    }).on("error", reject);
  });
}
async function extractTarball(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const buf = fs.readFileSync(tarPath);
  const inflated = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  let offset = 0;
  while (offset + 512 <= inflated.length) {
    const header = inflated.slice(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.slice(0, 100).toString("utf8").replace(/\0+$/, "");
    const sizeOct = header.slice(124, 124 + 12).toString("utf8").replace(/\0+$/, "").trim();
    const size = parseInt(sizeOct, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    offset += 512;
    if (size > 0) {
      const data = inflated.slice(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;
      if (typeFlag === "0" || typeFlag === "\0") {
        const cleanName = name.replace(/^package\//, "");
        if (!cleanName || cleanName.endsWith("/")) continue;
        const filePath = path.join(destDir, cleanName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, data);
      }
    } else if (typeFlag === "5") {
      const cleanName = name.replace(/^package\//, "");
      if (cleanName) fs.mkdirSync(path.join(destDir, cleanName), { recursive: true });
    }
  }
}
async function fetchLatestRelease() {
  const rel = await httpsGetJson(RELEASES_API);
  const tag = rel.tag_name || rel.name;
  const version = String(tag || "").replace(/^v/, "");
  const asset = (rel.assets || []).find((a) => /\.tgz$/i.test(a.name));
  const downloadUrl = asset ? asset.browser_download_url : rel.tarball_url;
  return { version, downloadUrl, raw: rel };
}
async function ensureLatestVersion(installDir) {
  if (process.env.LEDGERLENS_SKIP_UPDATE === "1") { log("update check skipped"); return loadCurrent(installDir); }
  let current = loadCurrent(installDir);
  try {
    const latest = await fetchLatestRelease();
    if (!current || semverGt(latest.version, current.version)) {
      log("downloading v" + latest.version + " (current: " + (current ? "v" + current.version : "none") + ")");
      const versionsDir = path.join(installDir, "versions");
      fs.mkdirSync(versionsDir, { recursive: true });
      const targetDir = path.join(versionsDir, latest.version);
      if (!fs.existsSync(targetDir) || !fs.existsSync(path.join(targetDir, "server.js"))) {
        const tmpTar = path.join(installDir, "download-" + Date.now() + ".tgz");
        await httpsDownload(latest.downloadUrl, tmpTar);
        await extractTarball(tmpTar, targetDir);
        try { fs.unlinkSync(tmpTar); } catch { /* ignore */ }
      }
      // Install runtime npm dependencies into the newly-extracted version
      // dir if we haven't already (idempotent: skip when node_modules
      // already exists).
      if (!fs.existsSync(path.join(targetDir, "node_modules"))) {
        log("installing runtime dependencies for v" + latest.version + " (one-time, ~1m)");
        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        const r = spawnSync(npmCmd, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
          cwd: targetDir,
          stdio: "inherit",
          // Node 18+ refuses to spawn .cmd/.bat files with shell:false
          // (CVE-2024-27980). On Windows we have to set shell:true so the
          // npm.cmd shim is interpreted by cmd.exe; otherwise spawnSync
          // exits with status null and no stderr, masking the failure.
          shell: process.platform === "win32",
        });
        if (r.status !== 0) {
          throw new Error("npm install failed with exit code " + r.status);
        }
      }
      current = { version: latest.version, path: targetDir, installedAt: new Date().toISOString() };
      saveCurrent(installDir, current);
      log("installed v" + latest.version + " -> " + targetDir);
    } else {
      log("up to date (v" + current.version + ")");
    }
  } catch (err) {
    if (current) warn("update check failed (" + err.message + "); running existing v" + current.version);
    else throw new Error("No installed version and update check failed: " + err.message);
  }
  return current;
}
function pickFreePort() {
  if (process.env.LEDGERLENS_PORT) return Promise.resolve(parseInt(process.env.LEDGERLENS_PORT, 10));
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
function regenerateManifest(versionDir, host) {
  const tmpl = path.join(versionDir, "manifest.xml.template");
  const out = path.join(versionDir, "manifest.xml");
  if (!fs.existsSync(tmpl)) return out;
  const text = fs.readFileSync(tmpl, "utf8").replace(/{{HOST}}/g, host);
  fs.writeFileSync(out, text);
  return out;
}
async function waitForServer(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port }, () => { s.end(); resolve(true); });
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function ensureOfficeDevCerts(versionDir) {
  // Office Add-ins require https:// for SourceLocation URLs, even on
  // localhost. We use Microsoft's `office-addin-dev-certs` package to
  // generate + install a local development CA + cert (no admin required
  // on Windows; uses CurrentUser cert store). Idempotent.
  try {
    const certsPath = path.join(versionDir, "node_modules", "office-addin-dev-certs");
    if (!fs.existsSync(certsPath)) {
      warn("office-addin-dev-certs not installed; sideload may fail.");
      return false;
    }
    const certs = require(certsPath);
    if (typeof certs.ensureCertificatesAreInstalled === "function") {
      log("ensuring Office dev certs are installed (one-time, may prompt to trust a local CA)…");
      await certs.ensureCertificatesAreInstalled();
      return true;
    }
  } catch (err) {
    warn("could not install dev certs: " + (err && err.message ? err.message : err));
  }
  return false;
}

function trySideloadIntoExcel(versionDir, manifestPath) {
  // office-addin-debugging ships a .cmd shim on Windows. Node.js >=18 (post
  // CVE-2024-27980) refuses to spawn .cmd/.bat with shell:false, and it
  // fails *silently* with a non-zero exit and no output. Invoke the JS
  // entry through the current Node binary so we don't depend on the shim.
  const cliJs = path.join(versionDir, "node_modules", "office-addin-debugging", "cli.js");
  if (fs.existsSync(cliJs)) {
    log("sideloading manifest into Excel desktop");
    const res = spawnSync(process.execPath, [cliJs, "start", manifestPath, "desktop"], {
      stdio: "inherit",
      shell: false,
    });
    if (res.status === 0) return true;
    warn("sideload returned non-zero status (" + res.status + ") — close Excel completely and rerun, or sideload manually: " + manifestPath);
    return false;
  }
  warn("office-addin-debugging not installed; sideload manually: " + manifestPath);
  return false;
}
async function main() {
  const installDir = getInstallDir();
  fs.mkdirSync(installDir, { recursive: true });
  let current = await ensureLatestVersion(installDir);
  let versionDir;
  if (current && fs.existsSync(path.join(current.path, "server.js"))) {
    versionDir = current.path;
  } else {
    const checkoutRoot = path.resolve(__dirname, "..");
    if (fs.existsSync(path.join(checkoutRoot, "server.js"))) {
      versionDir = checkoutRoot;
      log("no released version installed; running from " + versionDir);
    } else {
      throw new Error("No installed version and no local server.js. Aborting.");
    }
  }
  const certsReady = await ensureOfficeDevCerts(versionDir);
  const port = await pickFreePort();
  const scheme = certsReady ? "https" : "http";
  const host = scheme + "://localhost:" + port;
  const manifestPath = regenerateManifest(versionDir, host);
  log("starting server on " + host);
  const child = spawn(process.execPath, [path.join(versionDir, "server.js")], {
    cwd: versionDir,
    env: { ...process.env, PORT: String(port), LEDGERLENS_FORCE_HTTP: certsReady ? "" : "1" },
    stdio: "inherit",
  });
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { child.kill(); } catch { /* ignore */ } };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => { log("server exited (code " + code + ")"); process.exit(code || 0); });
  const ready = await waitForServer("127.0.0.1", port, 15000);
  if (!ready) warn("server did not become ready within 15s");
  else {
    log("server is live at " + host);
    if (!certsReady) {
      warn("Office Add-ins require https:// — Excel sideload will fail. Install dev certs and re-run.");
    }
    if (fs.existsSync(manifestPath)) trySideloadIntoExcel(versionDir, manifestPath);
    log("press Ctrl+C to stop");
  }
}
main().catch((err) => { console.error("[ledgerlens] fatal:", err && err.stack ? err.stack : err); process.exit(1); });