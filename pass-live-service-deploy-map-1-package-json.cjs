const fs = require("fs");
const path = require("path");
const file = path.join(process.cwd(), "package.json");
const pass = "PASS_LIVE_SERVICE_DEPLOY_MAP_1_PACKAGE_JSON";
if (!fs.existsSync(file)) {
  console.error("PATCH FAILED: package.json not found:", file);
  process.exit(1);
}
const backup = file.replace(/\.json$/, `.BEFORE-${pass}.${Date.now()}.json`);
fs.copyFileSync(file, backup);
let raw = fs.readFileSync(file, "utf8");
// Remove UTF-8 BOM if PowerShell saved one.
raw = raw.replace(/^\uFEFF/, "");
const pkg = JSON.parse(raw);
pkg.name = pkg.name || "stro-chievery-server";
pkg.version = pkg.version || "1.0.0";
pkg.private = true;
pkg.scripts = {
  "start": "node ticket-server.js",
  "start:main": "node index.js",
  "start:ticket": "node ticket-server.js",
  "start:vendor": "node agv-vendor-gateway-server.js",
  "start:livekit": "node livekit-token-server.js",
  "start:subscription": "node subscription-server.js",
  "start:billing": "node stripe-billing-server.js",
  "start:wallet": "node agv-free-token-server.cjs",
  "start:chat": "node agv-chat-server.js",
  "start:moderator": "node agv-moderator-server.js",
  "start:event": "node agv-event-server.js",
  "start:bulletin": "node agv-bulletin-server.js",
  "check:main": "node --check index.js",
  "check:ticket": "node --check ticket-server.js",
  "check:vendor": "node --check agv-vendor-gateway-server.js"
};
pkg.dependencies = {
  "@supabase/supabase-js": "^2.104.1",
  "bcryptjs": "^3.0.3",
  "cors": "^2.8.6",
  "dotenv": "^17.4.2",
  "express": "^4.22.1",
  "jsonwebtoken": "^9.0.3",
  "livekit-server-sdk": "^2.15.2",
  "multer": "^2.1.1",
  "pg": "^8.21.0",
  "socket.io": "^4.8.3",
  "stripe": "^22.1.1"
};
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(pass + " installed successfully.");
console.log("Backup created:");
console.log(backup);
console.log("");
console.log("What changed:");
console.log("- Removed BOM issue while reading package.json.");
console.log("- Added Render deployment scripts for each AGV server.");
console.log("- Added production dependency declarations.");
console.log("- Kept npm start pointed at ticket-server.js.");
console.log("- No server route/payment/vendor/ticket logic changed.");
