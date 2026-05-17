/**
 * Postinstall script — patches every copy of `vscode-jsonrpc` under
 * node_modules so its sub-path imports (`vscode-jsonrpc/node` etc.) resolve
 * under Node's strict ESM resolver.
 *
 * Background: `vscode-jsonrpc@8.x` exposes `node.js`, `browser.js`,
 * `lib/node/main.js` etc. at the package root but ships no `exports` map.
 * Node 22+ requires `exports` (or `.js` in the specifier) to resolve a
 * sub-path; the GitHub Copilot SDK we depend on does
 * `import 'vscode-jsonrpc/node'`, which Node rejects with
 *   Cannot find module 'vscode-jsonrpc/node' imported from ...
 *   Did you mean to import "vscode-jsonrpc/node.js"?
 *
 * Patching the package.json with a permissive `exports` map fixes both ESM
 * and CJS callers and is the lowest-risk workaround until vscode-jsonrpc
 * upstream ships an `exports` field of its own.
 */
const fs = require("fs");
const path = require("path");

const exportsField = {
  ".":          { "import": "./lib/node/main.js", "require": "./lib/node/main.js" },
  "./*":        "./*",
  "./node":     { "import": "./node.js", "require": "./node.js" },
  "./node.js":  { "import": "./node.js", "require": "./node.js" },
  "./browser":    { "import": "./browser.js", "require": "./browser.js" },
  "./browser.js": { "import": "./browser.js", "require": "./browser.js" },
};

// Recursively find every node_modules/vscode-jsonrpc/package.json under the
// project root. Walks nested node_modules so deeply-nested copies (e.g.
// transitive deps of @microsoft/dev-tunnels-*) are patched too.
function findPackages(root, out) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(root, ent.name);
    if (ent.name === "vscode-jsonrpc") {
      const pkg = path.join(sub, "package.json");
      if (fs.existsSync(pkg)) out.push(pkg);
      continue;
    }
    if (ent.name === "node_modules") {
      findPackages(sub, out);
    } else if (ent.name.startsWith("@") || ent.name.startsWith("_")) {
      // Walk scope dirs (e.g. @microsoft) and recurse one level into them.
      findPackages(sub, out);
    } else {
      // Any package can have its own nested node_modules.
      const nested = path.join(sub, "node_modules");
      if (fs.existsSync(nested)) findPackages(nested, out);
    }
  }
}

const root = path.join(__dirname, "..", "node_modules");
const candidates = [];
findPackages(root, candidates);

let patched = 0;
let skipped = 0;
for (const pkgPath of candidates) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
  if (pkg.exports) { skipped++; continue; }
  pkg.exports = exportsField;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[postinstall] patched vscode-jsonrpc at ${path.relative(path.join(__dirname, ".."), pkgPath)}`);
  patched++;
}

if (candidates.length === 0) {
  console.log("[postinstall] no vscode-jsonrpc copies found under node_modules");
} else if (patched === 0) {
  console.log(`[postinstall] vscode-jsonrpc already has exports in ${skipped} copy/copies`);
}