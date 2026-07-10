const fs = require("fs");
const path = require("path");
const file = path.join(process.cwd(), "ticket-server.js");
const pass = "PASS_LIVE_TICKET_PERSISTENCE_1A";
if (!fs.existsSync(file)) {
  console.error("PATCH FAILED: ticket-server.js not found:", file);
  process.exit(1);
}
let src = fs.readFileSync(file, "utf8");
if (src.includes(pass)) {
  console.log(pass + " already installed. No changes made.");
  process.exit(0);
}
const backup = file.replace(/\.js$/, `.BEFORE-${pass}-V2.${Date.now()}.js`);
fs.writeFileSync(backup, src, "utf8");
console.log("Backup created:");
console.log(backup);
function fail(message) {
  console.error("PATCH FAILED:", message);
  console.error("Backup preserved at:");
  console.error(backup);
  process.exit(1);
}
function replaceOnce(from, to, label) {
  if (!src.includes(from)) {
    fail("Could not find block: " + label);
  }
  src = src.replace(from, to);
}
replaceOnce(
`const Stripe = require("stripe");
const app = express();`,
`const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js"); // ${pass}
const app = express();`,
"add Supabase client import"
);
replaceOnce(
`const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;`,
`const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim(); // ${pass}
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    ""
).trim();
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;
const supabaseTicketPersistenceEnabled = Boolean(supabase);`,
"add Supabase env/client block"
);
replaceOnce(
`function writeCheckouts(checkouts) {
  writeJsonFile(CHECKOUTS_FILE, { checkouts });
}`,
`function writeCheckouts(checkouts) {
  writeJsonFile(CHECKOUTS_FILE, { checkouts });
}
// ${pass} - Supabase mirror + Supabase-first reads + JSON fallback.
function ticketToSupabaseRow(ticket) {
  return {
    code: String(ticket?.code || "").trim().toUpperCase(),
    buyer_email: String(ticket?.buyerEmail || "").trim().toLowerCase(),
    room_id: String(ticket?.roomId || "main-hall").trim(),
    event_name: String(ticket?.eventName || "AGV Live Event").trim(),
    stripe_checkout_session_id: String(ticket?.stripeCheckoutSessionId || "").trim(),
    checkout_id: String(ticket?.checkoutId || "").trim(),
    payment_status: String(ticket?.paymentStatus || "").trim(),
    ticket_status: String(ticket?.ticketStatus || "").trim(),
    amount_total_cents: Number.isFinite(Number(ticket?.amountTotalCents))
      ? Math.round(Number(ticket.amountTotalCents))
      : null,
    payload: ticket || {},
    updated_at: new Date().toISOString(),
  };
}
function checkoutToSupabaseRow(checkout) {
  return {
    checkout_id: String(checkout?.checkoutId || "").trim(),
    stripe_checkout_session_id: String(checkout?.stripeCheckoutSessionId || "").trim(),
    buyer_email: String(checkout?.buyerEmail || "").trim().toLowerCase(),
    room_id: String(checkout?.roomId || "main-hall").trim(),
    event_name: String(checkout?.eventName || "AGV Live Event").trim(),
    status: String(checkout?.status || "").trim(),
    payment_status: String(checkout?.paymentStatus || "").trim(),
    amount_cents: Number.isFinite(Number(checkout?.amountCents))
      ? Math.round(Number(checkout.amountCents))
      : null,
    ticket_issued: Boolean(checkout?.ticketIssued),
    ticket_code: String(checkout?.ticketCode || "").trim().toUpperCase(),
    payload: checkout || {},
    updated_at: new Date().toISOString(),
  };
}
async function readTicketsPersisted() {
  const jsonTickets = readTickets();
  if (!supabase) {
    return jsonTickets;
  }
  try {
    const { data, error } = await supabase
      .from("agv_ticket_records")
      .select("payload")
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("AGV TICKET SUPABASE READ TICKETS FALLBACK:", error.message);
      return jsonTickets;
    }
    const supabaseTickets = Array.isArray(data)
      ? data.map((row) => row.payload).filter(Boolean)
      : [];
    return supabaseTickets.length ? supabaseTickets : jsonTickets;
  } catch (error) {
    console.warn("AGV TICKET SUPABASE READ TICKETS ERROR:", error.message);
    return jsonTickets;
  }
}
async function readCheckoutsPersisted() {
  const jsonCheckouts = readCheckouts();
  if (!supabase) {
    return jsonCheckouts;
  }
  try {
    const { data, error } = await supabase
      .from("agv_ticket_checkouts")
      .select("payload")
      .order("created_at", { ascending: false });
    if (error) {
      console.warn("AGV TICKET SUPABASE READ CHECKOUTS FALLBACK:", error.message);
      return jsonCheckouts;
    }
    const supabaseCheckouts = Array.isArray(data)
      ? data.map((row) => row.payload).filter(Boolean)
      : [];
    return supabaseCheckouts.length ? supabaseCheckouts : jsonCheckouts;
  } catch (error) {
    console.warn("AGV TICKET SUPABASE READ CHECKOUTS ERROR:", error.message);
    return jsonCheckouts;
  }
}
async function writeTicketsPersisted(tickets) {
  writeTickets(tickets);
  if (!supabase) {
    return;
  }
  const rows = (Array.isArray(tickets) ? tickets : [])
    .filter((ticket) => ticket && ticket.code)
    .map(ticketToSupabaseRow);
  if (!rows.length) {
    return;
  }
  const { error } = await supabase
    .from("agv_ticket_records")
    .upsert(rows, { onConflict: "code" });
  if (error) {
    console.warn("AGV TICKET SUPABASE WRITE TICKETS FAILED:", error.message);
  }
}
async function writeCheckoutsPersisted(checkouts) {
  writeCheckouts(checkouts);
  if (!supabase) {
    return;
  }
  const rows = (Array.isArray(checkouts) ? checkouts : [])
    .filter((checkout) => checkout && checkout.checkoutId)
    .map(checkoutToSupabaseRow);
  if (!rows.length) {
    return;
  }
  const { error } = await supabase
    .from("agv_ticket_checkouts")
    .upsert(rows, { onConflict: "checkout_id" });
  if (error) {
    console.warn("AGV TICKET SUPABASE WRITE CHECKOUTS FAILED:", error.message);
  }
}
async function findTicketByCheckoutSessionIdPersisted(sessionId) {
  const tickets = await readTicketsPersisted();
  return tickets.find((ticket) => String(ticket.stripeCheckoutSessionId || "") === String(sessionId || ""));
}
async function resetTicketsPersisted() {
  writeTickets([]);
  if (!supabase) {
    return;
  }
  const { error } = await supabase
    .from("agv_ticket_records")
    .delete()
    .neq("code", "__never_match__");
  if (error) {
    console.warn("AGV TICKET SUPABASE RESET TICKETS FAILED:", error.message);
  }
}
async function resetCheckoutsPersisted() {
  writeCheckouts([]);
  if (!supabase) {
    return;
  }
  const { error } = await supabase
    .from("agv_ticket_checkouts")
    .delete()
    .neq("checkout_id", "__never_match__");
  if (error) {
    console.warn("AGV TICKET SUPABASE RESET CHECKOUTS FAILED:", error.message);
  }
}`,
"add persistence helpers"
);
replaceOnce(
`app.get("/api/tickets/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    pass: "AGV_REVENUE_LOCK_1B",
    stripeConfigured: Boolean(stripe),
    appBaseUrl: APP_BASE_URL,
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
    ticketCount: readTickets().length,
    checkoutCount: readCheckouts().length,
  });
});`,
`app.get("/api/tickets/health", async (req, res) => {
  const tickets = await readTicketsPersisted();
  const checkouts = await readCheckoutsPersisted();
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    pass: "AGV_REVENUE_LOCK_1B",
    persistencePass: "${pass}",
    stripeConfigured: Boolean(stripe),
    supabasePersistenceConfigured: supabaseTicketPersistenceEnabled,
    appBaseUrl: APP_BASE_URL,
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
    ticketCount: tickets.length,
    checkoutCount: checkouts.length,
  });
});`,
"patch health route"
);
replaceOnce(
`app.get("/api/tickets/list", requireTicketAdmin, (req, res) => {
  res.json({
    ok: true,
    tickets: readTickets(),
  });
});`,
`app.get("/api/tickets/list", requireTicketAdmin, async (req, res) => {
  res.json({
    ok: true,
    tickets: await readTicketsPersisted(),
  });
});`,
"patch admin list route"
);
replaceOnce(
`app.post("/api/tickets/create", requireTicketAdmin, (req, res) => {
  const tickets = readTickets();`,
`app.post("/api/tickets/create", requireTicketAdmin, async (req, res) => {
  const tickets = await readTicketsPersisted();`,
"patch create route async/read"
);
replaceOnce(
`  tickets.unshift(ticket);
  writeTickets(tickets);
  res.status(201).json({`,
`  tickets.unshift(ticket);
  await writeTicketsPersisted(tickets);
  res.status(201).json({`,
"patch create route write"
);
replaceOnce(
`    const checkouts = readCheckouts();`,
`    const checkouts = await readCheckoutsPersisted();`,
"patch checkout read"
);
replaceOnce(
`    checkouts.unshift(checkoutRecord);
    writeCheckouts(checkouts);
    res.status(201).json({`,
`    checkouts.unshift(checkoutRecord);
    await writeCheckoutsPersisted(checkouts);
    res.status(201).json({`,
"patch checkout write"
);
replaceOnce(
`    const existingTicket = findTicketByCheckoutSessionId(sessionId);`,
`    const existingTicket = await findTicketByCheckoutSessionIdPersisted(sessionId);`,
"patch confirm existing ticket lookup"
);
replaceOnce(
`    const checkouts = readCheckouts();`,
`    const checkouts = await readCheckoutsPersisted();`,
"patch confirm checkouts read"
);
replaceOnce(
`      writeCheckouts(checkouts);
      return res.status(409).json({`,
`      await writeCheckoutsPersisted(checkouts);
      return res.status(409).json({`,
"patch confirm amount review write"
);
replaceOnce(
`    const tickets = readTickets();
    tickets.unshift(ticket);
    writeTickets(tickets);`,
`    const tickets = await readTicketsPersisted();
    tickets.unshift(ticket);
    await writeTicketsPersisted(tickets);`,
"patch confirm ticket write"
);
replaceOnce(
`    writeCheckouts(checkouts);
    res.status(201).json({`,
`    await writeCheckoutsPersisted(checkouts);
    res.status(201).json({`,
"patch confirm checkout final write"
);
replaceOnce(
`app.post("/api/tickets/verify", (req, res) => {`,
`app.post("/api/tickets/verify", async (req, res) => {`,
"patch verify async"
);
replaceOnce(
`  const tickets = readTickets();
  const ticket = tickets.find((item) => String(item.code || "").trim().toUpperCase() === code);`,
`  const tickets = await readTicketsPersisted();
  const ticket = tickets.find((item) => String(item.code || "").trim().toUpperCase() === code);`,
"patch verify read"
);
replaceOnce(
`  writeTickets(tickets);
  res.json({`,
`  await writeTicketsPersisted(tickets);
  res.json({`,
"patch verify write V2"
);
replaceOnce(
`app.post("/api/tickets/reset", requireTicketAdmin, (req, res) => {
  writeTickets([]);
  res.json({
    ok: true,
    message: "All tickets cleared.",
    tickets: [],
  });
});`,
`app.post("/api/tickets/reset", requireTicketAdmin, async (req, res) => {
  await resetTicketsPersisted();
  await resetCheckoutsPersisted();
  res.json({
    ok: true,
    message: "All tickets and checkouts cleared.",
    tickets: [],
    checkouts: [],
  });
});`,
"patch reset route"
);
fs.writeFileSync(file, src, "utf8");
console.log(pass + " V2 installed successfully.");
console.log("Updated:");
console.log(file);
console.log("");
console.log("What changed:");
console.log("- Added Supabase service-role client for ticket persistence.");
console.log("- Added Supabase-first reads with JSON fallback.");
console.log("- Added Supabase mirror writes for tickets and checkouts.");
console.log("- Health now reports supabasePersistenceConfigured.");
console.log("- Existing Stripe payment verification logic preserved.");
console.log("- Local JSON fallback preserved.");
