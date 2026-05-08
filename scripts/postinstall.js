/**
 * Postinstall script — patches vscode-jsonrpc inside @github/copilot-sdk
 * to add an exports field required by Node.js v23+ ESM resolution.
 */
const fs = require("fs");
const path = require("path");

const pkgPath = path.join(
  __dirname, "..", "node_modules", "@github", "copilot-sdk",
  "node_modules", "vscode-jsonrpc", "package.json"
);

if (!fs.existsSync(pkgPath)) {
  console.log("[postinstall] vscode-jsonrpc not found, skipping patch.");
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

if (pkg.exports) {
  console.log("[postinstall] vscode-jsonrpc already has exports, skipping.");
  process.exit(0);
}

pkg.exports = {
  ".": { "import": "./lib/node/main.js", "require": "./lib/node/main.js" },
  "./*": "./*",
  "./node": { "import": "./node.js", "require": "./node.js" },
  "./node.js": { "import": "./node.js", "require": "./node.js" },
  "./browser": { "import": "./browser.js", "require": "./browser.js" },
};

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("[postinstall] Patched vscode-jsonrpc exports for Node.js v23+ ESM compatibility.");
