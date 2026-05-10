/**
 * Postinstall script — patches vscode-jsonrpc to add an exports field
 * required by Node.js v23+ ESM resolution. Patches both the nested copy
 * (older npm) and the hoisted copy (newer npm).
 */
const fs = require("fs");
const path = require("path");

const candidates = [
  path.join(__dirname, "..", "node_modules", "@github", "copilot-sdk", "node_modules", "vscode-jsonrpc", "package.json"),
  path.join(__dirname, "..", "node_modules", "vscode-jsonrpc", "package.json"),
];

const exportsField = {
  ".": { "import": "./lib/node/main.js", "require": "./lib/node/main.js" },
  "./*": "./*",
  "./node": { "import": "./node.js", "require": "./node.js" },
  "./node.js": { "import": "./node.js", "require": "./node.js" },
  "./browser": { "import": "./browser.js", "require": "./browser.js" },
};

let patched = 0;
for (const pkgPath of candidates) {
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.exports) {
    console.log(`[postinstall] vscode-jsonrpc already has exports: ${pkgPath}`);
    continue;
  }
  pkg.exports = exportsField;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[postinstall] Patched ${pkgPath}`);
  patched++;
}

if (patched === 0) console.log("[postinstall] No vscode-jsonrpc package.json patched.");
