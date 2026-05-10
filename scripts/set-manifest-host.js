#!/usr/bin/env node
/**
 * Rewrite manifest.xml URLs to point at a deployed origin.
 * Usage: node scripts/set-manifest-host.js https://app-xxx.azurewebsites.net
 *        node scripts/set-manifest-host.js --reset   (back to https://localhost:3002)
 */
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/set-manifest-host.js <https-url> | --reset");
  process.exit(1);
}

const file = path.join(__dirname, "..", "manifest.xml");
const original = fs.readFileSync(file, "utf8");

const knownHosts = [
  /https:\/\/localhost:3002/g,
  /https:\/\/[a-z0-9-]+\.azurewebsites\.net/g,
  /https:\/\/ca-[a-z0-9-]+\.[a-z0-9-]+\.[a-z]+\.azurecontainerapps\.io/g,
];

const newHost = target === "--reset" ? "https://localhost:3002" : target.replace(/\/+$/, "");
if (!/^https:\/\//.test(newHost)) {
  console.error("Target URL must use https://");
  process.exit(1);
}

let out = original;
for (const re of knownHosts) out = out.replace(re, newHost);

if (out === original) {
  console.log("No host occurrences updated (already pointing at target?).");
} else {
  fs.writeFileSync(file, out);
  console.log(`manifest.xml URLs rewritten -> ${newHost}`);
}
