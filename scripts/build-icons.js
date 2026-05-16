/**
 * Build all icon PNG sizes from assets/icon.svg using sharp.
 *
 * Run via:  node scripts/build-icons.js
 *
 * sharp is intentionally NOT a project dependency — it's only needed when
 * rebuilding the icon set, so we resolve it via `npx -p sharp` in the
 * companion `npm run build:icons` script (see package.json) or expect the
 * developer to `npm install --no-save sharp` ahead of time. This keeps the
 * runtime install fast.
 */

const fs = require("fs");
const path = require("path");

let sharp;
try {
  sharp = require("sharp");
} catch (err) {
  console.error(
    "[build-icons] `sharp` is not installed.\n" +
    "Install it temporarily with:  npm install --no-save sharp\n" +
    "Then re-run:                  node scripts/build-icons.js"
  );
  process.exit(1);
}

const root      = path.resolve(__dirname, "..");
const assetsDir = path.join(root, "assets");
const masterSvg = path.join(assetsDir, "icon.svg");
const sizes     = [16, 32, 64, 80, 128, 256, 512];

if (!fs.existsSync(masterSvg)) {
  console.error(`[build-icons] master SVG not found at ${masterSvg}`);
  process.exit(1);
}

const svgBuffer = fs.readFileSync(masterSvg);

async function main() {
  for (const size of sizes) {
    const out = path.join(assetsDir, `icon-${size}.png`);
    await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(out);
    const bytes = fs.statSync(out).size;
    console.log(`  ${size.toString().padStart(3)}×${size}  →  ${path.relative(root, out)}  (${bytes} B)`);
  }
}

main().catch((err) => {
  console.error("[build-icons] failed:", err);
  process.exit(1);
});
