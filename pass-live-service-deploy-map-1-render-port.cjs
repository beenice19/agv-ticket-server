const fs = require("fs");
const path = require("path");
const file = path.join(process.cwd(), "index.js");
const pass = "PASS_LIVE_SERVICE_DEPLOY_MAP_1_RENDER_PORT";
if (!fs.existsSync(file)) {
  console.error("PATCH FAILED: index.js not found:", file);
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");
if (src.includes(pass)) {
  console.log(pass + " already installed. No changes made.");
  process.exit(0);
}
const backup = file.replace(/\.js$/, `.BEFORE-${pass}.${Date.now()}.js`);
fs.writeFileSync(backup, src, "utf8");
console.log("Backup created:");
console.log(backup);
const from = "const PORT = 8787;";
const to = `const PORT = Number(process.env.PORT || 8787); // ${pass}`;
if (!src.includes(from)) {
  console.error("PATCH FAILED: Could not find hardcoded PORT line.");
  console.error("Backup preserved at:");
  console.error(backup);
  process.exit(1);
}
src = src.replace(from, to);
fs.writeFileSync(file, src, "utf8");
console.log(pass + " installed successfully.");
console.log("Updated:");
console.log(file);
console.log("");
console.log("What changed:");
console.log("- index.js now uses process.env.PORT for Render.");
console.log("- Local fallback remains 8787.");
console.log("- No route, payment, ticket, vendor, or LiveKit logic changed.");
