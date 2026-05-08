const fs = require("fs");
let code = fs.readFileSync("src/server/copilot-proxy.js", "utf8");

// Find and replace all manual parsing blocks with parseAIResponse
// Pattern: let parsed; try { let clean = content; if (...) { ... } parsed = JSON.parse(clean); } catch { parsed = { action: "explain" ... }; }
const oldPattern = /let parsed;\s*\n\s*try \{\s*\n\s*let clean = content;\s*\n\s*if \(clean\.startsWith\([^)]+\)\) \{\s*\n\s*clean = clean\.replace\([^)]+\)\.replace\([^)]+\);\s*\n\s*\}\s*\n\s*parsed = JSON\.parse\(clean\);\s*\n\s*\} catch \{\s*\n\s*parsed = \{[^}]*action[^}]*\};\s*\n\s*\}/g;

const matches = code.match(oldPattern);
console.log("Found", matches ? matches.length : 0, "instances");

if (matches) {
  code = code.replace(oldPattern, "const parsed = parseAIResponse(content);");
  fs.writeFileSync("src/server/copilot-proxy.js", code);
  console.log("Replaced all instances");
} else {
  console.log("No matches - trying simpler approach");
  // Simpler: just replace each occurrence individually
  let count = 0;
  while (code.includes("parsed = JSON.parse(clean);")) {
    // Find the block around it
    const idx = code.indexOf("parsed = JSON.parse(clean);");
    // Find "let parsed;" before it
    const blockStart = code.lastIndexOf("let parsed;", idx);
    // Find the closing catch block after the parse
    const catchIdx = code.indexOf("} catch {", idx);
    const closingIdx = code.indexOf("}", catchIdx + 9);
    const nextSemicolon = code.indexOf(";", closingIdx);
    
    if (blockStart !== -1 && catchIdx !== -1 && nextSemicolon !== -1) {
      const oldBlock = code.slice(blockStart, nextSemicolon + 1);
      code = code.slice(0, blockStart) + "const parsed = parseAIResponse(content);" + code.slice(nextSemicolon + 1);
      count++;
    } else {
      break;
    }
  }
  if (count > 0) {
    fs.writeFileSync("src/server/copilot-proxy.js", code);
    console.log("Replaced", count, "instances via simple approach");
  }
}
