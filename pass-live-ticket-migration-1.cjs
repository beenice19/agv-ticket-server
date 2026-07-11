require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    ""
).trim();
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("MIGRATION FAILED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
const ticketsPath = path.join(process.cwd(), "agv-tickets.json");
const checkoutsPath = path.join(process.cwd(), "agv-ticket-checkouts.json");
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function ticketToRow(ticket) {
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
function checkoutToRow(checkout) {
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
async function main() {
  const ticketData = readJson(ticketsPath, { tickets: [] });
  const checkoutData = readJson(checkoutsPath, { checkouts: [] });
  const tickets = Array.isArray(ticketData.tickets) ? ticketData.tickets : [];
  const checkouts = Array.isArray(checkoutData.checkouts) ? checkoutData.checkouts : [];
  const ticketRows = tickets.filter((ticket) => ticket && ticket.code).map(ticketToRow);
  const checkoutRows = checkouts.filter((checkout) => checkout && checkout.checkoutId).map(checkoutToRow);
  console.log("AGV LIVE TICKET MIGRATION");
  console.log("Tickets to migrate:", ticketRows.length);
  console.log("Checkouts to migrate:", checkoutRows.length);
  if (ticketRows.length) {
    const { error } = await supabase
      .from("agv_ticket_records")
      .upsert(ticketRows, { onConflict: "code" });
    if (error) {
      console.error("Ticket migration failed:", error.message);
      process.exit(1);
    }
  }
  if (checkoutRows.length) {
    const { error } = await supabase
      .from("agv_ticket_checkouts")
      .upsert(checkoutRows, { onConflict: "checkout_id" });
    if (error) {
      console.error("Checkout migration failed:", error.message);
      process.exit(1);
    }
  }
  const { count: ticketCount, error: ticketCountError } = await supabase
    .from("agv_ticket_records")
    .select("*", { count: "exact", head: true });
  if (ticketCountError) {
    console.error("Ticket count check failed:", ticketCountError.message);
    process.exit(1);
  }
  const { count: checkoutCount, error: checkoutCountError } = await supabase
    .from("agv_ticket_checkouts")
    .select("*", { count: "exact", head: true });
  if (checkoutCountError) {
    console.error("Checkout count check failed:", checkoutCountError.message);
    process.exit(1);
  }
  console.log("Migration complete.");
  console.log("Supabase ticket count:", ticketCount);
  console.log("Supabase checkout count:", checkoutCount);
}
main().catch((error) => {
  console.error("MIGRATION FAILED:", error.message);
  process.exit(1);
});
