// PASS_AGV_REVENUE_LOCK_1B_STRIPE_TICKET_CHECKOUT
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js"); // PASS_LIVE_TICKET_PERSISTENCE_1A
const app = express();
const PORT = Number(process.env.PORT || process.env.TICKET_SERVER_PORT || 8790);
const DATA_FILE = path.join(__dirname, "agv-tickets.json");
const CHECKOUTS_FILE = path.join(__dirname, "agv-ticket-checkouts.json");
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim(); // PASS_LIVE_TICKET_PERSISTENCE_1A
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
const supabaseTicketPersistenceEnabled = Boolean(supabase);
const DEFAULT_ADMIN_PIN = "AGVElizabethT96Render4827";
const ADMIN_PIN = String(
  process.env.AGV_TICKET_ADMIN_PIN ||
    process.env.TICKET_ADMIN_PIN ||
    process.env.ADMIN_PIN ||
    DEFAULT_ADMIN_PIN
).trim();
const APP_BASE_URL = String(
  process.env.AGV_APP_BASE_URL ||
    process.env.CLIENT_URL ||
    process.env.FRONTEND_URL ||
    "http://127.0.0.1:5175"
).replace(/\/+$/, "");
app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-agv-admin-pin"],
  })
);
app.use(express.json({ limit: "1mb" }));
function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}
function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}
function readTickets() {
  const parsed = readJsonFile(DATA_FILE, { tickets: [] });
  return Array.isArray(parsed.tickets) ? parsed.tickets : [];
}
function writeTickets(tickets) {
  writeJsonFile(DATA_FILE, { tickets });
}
function readCheckouts() {
  const parsed = readJsonFile(CHECKOUTS_FILE, { checkouts: [] });
  return Array.isArray(parsed.checkouts) ? parsed.checkouts : [];
}
function writeCheckouts(checkouts) {
  writeJsonFile(CHECKOUTS_FILE, { checkouts });
}
// PASS_LIVE_TICKET_PERSISTENCE_1A - Supabase mirror + Supabase-first reads + JSON fallback.
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
}
function getProvidedAdminPin(req) {
  return String(
    req.headers["x-agv-admin-pin"] ||
      req.query.adminPin ||
      req.body?.adminPin ||
      ""
  ).trim();
}
function requireTicketAdmin(req, res, next) {
  const providedPin = getProvidedAdminPin(req);
  if (!providedPin || providedPin !== ADMIN_PIN) {
    return res.status(401).json({
      ok: false,
      error: "Ticket admin access denied.",
      message: "Invalid ticket admin PIN.",
      adminPinConfigured: Boolean(ADMIN_PIN),
    });
  }
  return next();
}
function makeTicketCode() {
  return `AGV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function makeCheckoutId() {
  return `agv_ticket_checkout_${crypto.randomBytes(8).toString("hex")}`;
}
function normalizeRoomId(value) {
  const clean = String(value || "main-hall")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || "main-hall";
}
function cleanText(value, fallback = "") {
  return String(value || fallback).trim();
}
function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function toCents(value) {
  if (Number.isInteger(value)) return value;
  const asText = String(value || "").replace(/[^0-9.]/g, "");
  const asNumber = Number(asText);
  if (!Number.isFinite(asNumber)) return 0;
  return Math.round(asNumber * 100);
}
function dollars(cents) {
  return Math.round(Number(cents || 0)) / 100;
}
function calculateRevenue(amountTotalCents, broadcastDeliveryFeeCents = 0, paymentProcessingFeeCents = 0) {
  const grossTicketRevenueCents = Math.max(0, Math.round(Number(amountTotalCents || 0)));
  const agvPlatformFeeCents = Math.round(grossTicketRevenueCents * 0.07);
  const safeBroadcastDeliveryFeeCents = Math.max(0, Math.round(Number(broadcastDeliveryFeeCents || 0)));
  const safePaymentProcessingFeeCents = Math.max(0, Math.round(Number(paymentProcessingFeeCents || 0)));
  const hostVendorNetRevenueCents = Math.max(
    0,
    grossTicketRevenueCents -
      agvPlatformFeeCents -
      safeBroadcastDeliveryFeeCents -
      safePaymentProcessingFeeCents
  );
  return {
    formula: "Gross Ticket Revenue - AGV 7% Platform Fee - Broadcast Delivery Fee - Payment Processing Fee = Host / Vendor Net Revenue",
    grossTicketRevenueCents,
    agvPlatformFeeCents,
    broadcastDeliveryFeeCents: safeBroadcastDeliveryFeeCents,
    paymentProcessingFeeCents: safePaymentProcessingFeeCents,
    hostVendorNetRevenueCents,
    grossTicketRevenue: dollars(grossTicketRevenueCents),
    agvPlatformFee: dollars(agvPlatformFeeCents),
    broadcastDeliveryFee: dollars(safeBroadcastDeliveryFeeCents),
    paymentProcessingFee: dollars(safePaymentProcessingFeeCents),
    hostVendorNetRevenue: dollars(hostVendorNetRevenueCents),
  };
}
function estimateStripeProcessingFeeCents(amountTotalCents) {
  // Estimate only. Actual processor fees should be reconciled later from Stripe balance transactions.
  return Math.round(Number(amountTotalCents || 0) * 0.029 + 30);
}
function findTicketByCheckoutSessionId(sessionId) {
  const tickets = readTickets();
  return tickets.find((ticket) => String(ticket.stripeCheckoutSessionId || "") === String(sessionId || ""));
}
function publicTicket(ticket) {
  return {
    code: ticket.code,
    buyerName: ticket.buyerName,
    buyerEmail: ticket.buyerEmail,
    eventName: ticket.eventName,
    roomId: ticket.roomId,
    ticketStatus: ticket.ticketStatus || "VALID",
    paymentStatus: ticket.paymentStatus || "manual",
    amountTotal: ticket.amountTotal,
    used: Boolean(ticket.used),
    checkedIn: Boolean(ticket.checkedIn),
    createdAt: ticket.createdAt,
  };
}
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    pass: "AGV_REVENUE_LOCK_1B",
    stripeConfigured: Boolean(stripe),
    appBaseUrl: APP_BASE_URL,
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
  });
});
app.get("/api/tickets/health", async (req, res) => {
  const tickets = await readTicketsPersisted();
  const checkouts = await readCheckoutsPersisted();
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    pass: "AGV_REVENUE_LOCK_1B",
    persistencePass: "PASS_LIVE_TICKET_PERSISTENCE_1A",
    stripeConfigured: Boolean(stripe),
    supabasePersistenceConfigured: supabaseTicketPersistenceEnabled,
    appBaseUrl: APP_BASE_URL,
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
    ticketCount: tickets.length,
    checkoutCount: checkouts.length,
  });
});
app.get("/api/tickets/debug-admin-pin", (req, res) => {
  const providedPin = getProvidedAdminPin(req);
  res.json({
    ok: true,
    debug: true,
    adminPinConfigured: Boolean(ADMIN_PIN),
    expectedLength: ADMIN_PIN.length,
    providedLength: providedPin.length,
    matches: providedPin === ADMIN_PIN,
    expectedFirstTwo: ADMIN_PIN ? ADMIN_PIN.slice(0, 2) : "",
    expectedLastTwo: ADMIN_PIN ? ADMIN_PIN.slice(-2) : "",
    providedFirstTwo: providedPin ? providedPin.slice(0, 2) : "",
    providedLastTwo: providedPin ? providedPin.slice(-2) : "",
    note: "This route does not reveal the full admin PIN.",
  });
});
app.get("/api/tickets/list", requireTicketAdmin, async (req, res) => {
  res.json({
    ok: true,
    tickets: await readTicketsPersisted(),
  });
});
app.post("/api/tickets/create", requireTicketAdmin, async (req, res) => {
  const tickets = await readTicketsPersisted();
  const buyerName = cleanText(req.body?.buyerName || req.body?.name || "Guest");
  const buyerEmail = cleanEmail(req.body?.buyerEmail || req.body?.email || "");
  const eventName = cleanText(req.body?.eventName || req.body?.event || "AGV Live Event");
  const roomId = normalizeRoomId(req.body?.roomId || req.body?.room || "main-hall");
  if (!buyerName || !buyerEmail) {
    return res.status(400).json({
      ok: false,
      error: "Buyer name and buyer email are required.",
    });
  }
  const ticket = {
    code: makeTicketCode(),
    buyerName,
    buyerEmail,
    eventName,
    roomId,
    used: false,
    checkedIn: false,
    ticketStatus: "VALID",
    paymentStatus: "manual-admin-created",
    createdAt: new Date().toISOString(),
  };
  tickets.unshift(ticket);
  await writeTicketsPersisted(tickets);
  res.status(201).json({
    ok: true,
    ticket,
    tickets,
  });
});
app.post("/api/tickets/checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: "Stripe is not configured. STRIPE_SECRET_KEY is missing.",
      });
    }
    const buyerName = cleanText(req.body?.buyerName || req.body?.name || "Guest");
    const buyerEmail = cleanEmail(req.body?.buyerEmail || req.body?.email || "");
    const eventName = cleanText(req.body?.eventName || req.body?.event || "AGV Live Event");
    const roomId = normalizeRoomId(req.body?.roomId || req.body?.room || "main-hall");
    const amountCents =
      toCents(req.body?.amountCents || req.body?.ticketAmountCents) ||
      toCents(req.body?.ticketPrice || req.body?.price || 0);
    if (!buyerName || !buyerEmail) {
      return res.status(400).json({
        ok: false,
        error: "Buyer name and buyer email are required.",
      });
    }
    if (amountCents < 50) {
      return res.status(400).json({
        ok: false,
        error: "Ticket price must be at least $0.50.",
      });
    }
    const checkoutId = makeCheckoutId();
    const successUrl =
      cleanText(req.body?.successUrl) ||
      `${APP_BASE_URL}/?agvTicketCheckout=success&sessionId={CHECKOUT_SESSION_ID}`;
    const cancelUrl =
      cleanText(req.body?.cancelUrl) ||
      `${APP_BASE_URL}/?agvTicketCheckout=cancelled`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: buyerEmail,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        agvType: "ticket_checkout",
        checkoutId,
        buyerName,
        buyerEmail,
        eventName,
        roomId,
        amountCents: String(amountCents),
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `AGV Ticket - ${eventName}`,
              description: `Room: ${roomId} | Buyer: ${buyerName}`,
              metadata: {
                checkoutId,
                roomId,
                eventName,
              },
            },
          },
        },
      ],
    });
    const checkouts = await readCheckoutsPersisted();
    const checkoutRecord = {
      checkoutId,
      stripeCheckoutSessionId: session.id,
      status: "PENDING",
      paymentStatus: session.payment_status || "unpaid",
      buyerName,
      buyerEmail,
      eventName,
      roomId,
      amountCents,
      amount: dollars(amountCents),
      successUrl,
      cancelUrl,
      createdAt: new Date().toISOString(),
      ticketIssued: false,
    };
    checkouts.unshift(checkoutRecord);
    await writeCheckoutsPersisted(checkouts);
    res.status(201).json({
      ok: true,
      checkoutId,
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
      paymentStatus: session.payment_status,
      amountCents,
      amount: dollars(amountCents),
      message: "Stripe Checkout session created. Ticket will only be issued after paid verification.",
    });
  } catch (error) {
    console.error("AGV TICKET CHECKOUT CREATE FAILED:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Ticket checkout failed.",
    });
  }
});
app.post("/api/tickets/confirm-checkout", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: "Stripe is not configured. STRIPE_SECRET_KEY is missing.",
      });
    }
    const sessionId = cleanText(req.body?.sessionId || req.body?.stripeCheckoutSessionId || req.query.sessionId);
    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Stripe checkout session ID is required.",
      });
    }
    const existingTicket = await findTicketByCheckoutSessionIdPersisted(sessionId);
    if (existingTicket) {
      return res.json({
        ok: true,
        alreadyIssued: true,
        ticket: publicTicket(existingTicket),
        roomId: existingTicket.roomId || "main-hall",
        revenue: existingTicket.revenue || null,
        message: "Ticket was already issued for this paid checkout session.",
      });
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== "paid") {
      return res.status(402).json({
        ok: false,
        verified: false,
        paymentStatus: session?.payment_status || "unknown",
        error: "Payment has not been verified as paid. No ticket was issued.",
      });
    }
    const checkouts = await readCheckoutsPersisted();
    const checkoutRecord = checkouts.find((item) => String(item.stripeCheckoutSessionId || "") === sessionId);
    if (!checkoutRecord) {
      return res.status(404).json({
        ok: false,
        error: "Checkout record was not found on AGV server. No ticket was issued.",
      });
    }
    const expectedAmount = Math.round(Number(checkoutRecord.amountCents || 0));
    const paidAmount = Math.round(Number(session.amount_total || 0));
    if (!expectedAmount || paidAmount !== expectedAmount) {
      checkoutRecord.status = "AMOUNT_REVIEW";
      checkoutRecord.paymentStatus = session.payment_status;
      checkoutRecord.stripeAmountTotal = paidAmount;
      checkoutRecord.updatedAt = new Date().toISOString();
      await writeCheckoutsPersisted(checkouts);
      return res.status(409).json({
        ok: false,
        error: "Paid amount did not match expected ticket amount. Manual review required. No ticket was issued.",
        expectedAmountCents: expectedAmount,
        paidAmountCents: paidAmount,
      });
    }
    const buyerName = checkoutRecord.buyerName || session.metadata?.buyerName || "Guest";
    const buyerEmail = cleanEmail(checkoutRecord.buyerEmail || session.customer_details?.email || session.customer_email || "");
    const eventName = checkoutRecord.eventName || session.metadata?.eventName || "AGV Live Event";
    const roomId = normalizeRoomId(checkoutRecord.roomId || session.metadata?.roomId || "main-hall");
    if (!buyerEmail) {
      return res.status(409).json({
        ok: false,
        error: "Paid checkout is missing buyer email. Manual review required. No ticket was issued.",
      });
    }
    const paymentProcessingFeeCents = estimateStripeProcessingFeeCents(paidAmount);
    const broadcastDeliveryFeeCents = Math.max(0, Math.round(Number(req.body?.broadcastDeliveryFeeCents || 0)));
    const revenue = calculateRevenue(paidAmount, broadcastDeliveryFeeCents, paymentProcessingFeeCents);
    const ticket = {
      code: makeTicketCode(),
      buyerName,
      buyerEmail,
      eventName,
      roomId,
      used: false,
      checkedIn: false,
      ticketStatus: "VALID",
      paymentStatus: "paid",
      paymentVerified: true,
      paymentVerifiedAt: new Date().toISOString(),
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || "",
      checkoutId: checkoutRecord.checkoutId || "",
      amountTotalCents: paidAmount,
      amountTotal: dollars(paidAmount),
      revenue,
      createdAt: new Date().toISOString(),
    };
    const tickets = await readTicketsPersisted();
    tickets.unshift(ticket);
    await writeTicketsPersisted(tickets);
    checkoutRecord.status = "PAID_TICKET_ISSUED";
    checkoutRecord.paymentStatus = "paid";
    checkoutRecord.ticketIssued = true;
    checkoutRecord.ticketCode = ticket.code;
    checkoutRecord.stripeAmountTotal = paidAmount;
    checkoutRecord.revenue = revenue;
    checkoutRecord.updatedAt = new Date().toISOString();
    await writeCheckoutsPersisted(checkouts);
    res.status(201).json({
      ok: true,
      verified: true,
      ticket: publicTicket(ticket),
      roomId,
      revenue,
      message: "Stripe payment verified. AGV ticket issued.",
    });
  } catch (error) {
    console.error("AGV TICKET CHECKOUT CONFIRM FAILED:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Ticket checkout confirmation failed.",
    });
  }
});
app.post("/api/tickets/verify", async (req, res) => {
  const code = String(req.body?.code || req.body?.ticketCode || "").trim().toUpperCase();
  if (!code) {
    return res.status(400).json({
      ok: false,
      error: "Ticket code is required.",
      message: "Enter your ticket code.",
    });
  }
  const tickets = await readTicketsPersisted();
  const ticket = tickets.find((item) => String(item.code || "").trim().toUpperCase() === code);
  if (!ticket) {
    return res.status(404).json({
      ok: false,
      error: "Ticket not found.",
      message: "Ticket failed.",
    });
  }
  if (ticket.ticketStatus && ticket.ticketStatus !== "VALID") {
    return res.status(403).json({
      ok: false,
      error: "Ticket is not valid.",
      message: "Ticket is not valid for entry.",
      ticketStatus: ticket.ticketStatus,
    });
  }
  ticket.used = true;
  ticket.checkedIn = true;
  ticket.lastVerifiedAt = new Date().toISOString();
  await writeTicketsPersisted(tickets);
  res.json({
    ok: true,
    verified: true,
    ticket,
    roomId: ticket.roomId || "main-hall",
    message: "Ticket approved.",
  });
});
app.post("/api/tickets/reset", requireTicketAdmin, async (req, res) => {
  await resetTicketsPersisted();
  await resetCheckoutsPersisted();
  res.json({
    ok: true,
    message: "All tickets and checkouts cleared.",
    tickets: [],
    checkouts: [],
  });
});
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found.",
    path: req.path,
  });
});
app.listen(PORT, () => {
  console.log("AGV TICKET SERVER RUNNING ON", PORT);
  console.log("PASS:", "AGV_REVENUE_LOCK_1B");
  console.log("DATA FILE:", DATA_FILE);
  console.log("CHECKOUTS FILE:", CHECKOUTS_FILE);
  console.log("STRIPE CONFIGURED:", Boolean(stripe));
  console.log("APP BASE URL:", APP_BASE_URL);
  console.log("ADMIN PIN CONFIGURED:", Boolean(ADMIN_PIN));
  console.log("ADMIN PIN LENGTH:", ADMIN_PIN.length);
});
