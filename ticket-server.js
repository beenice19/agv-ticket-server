const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.PORT || process.env.TICKET_SERVER_PORT || 8790);

const DATA_FILE = path.join(__dirname, "agv-tickets.json");

const DEFAULT_ADMIN_PIN = "AGVElizabethT96Render4827";

const ADMIN_PIN = String(
  process.env.AGV_TICKET_ADMIN_PIN ||
    process.env.TICKET_ADMIN_PIN ||
    process.env.ADMIN_PIN ||
    DEFAULT_ADMIN_PIN
).trim();

app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-agv-admin-pin"],
  })
);

app.use(express.json({ limit: "1mb" }));

function readTickets() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets: [] }, null, 2), "utf8");
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    if (!Array.isArray(parsed.tickets)) {
      return [];
    }

    return parsed.tickets;
  } catch {
    return [];
  }
}

function writeTickets(tickets) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ tickets }, null, 2), "utf8");
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

function normalizeRoomId(value) {
  const clean = String(value || "main-hall")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return clean || "main-hall";
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
  });
});

app.get("/api/tickets/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    adminPinConfigured: Boolean(ADMIN_PIN),
    adminPinLength: ADMIN_PIN.length,
    ticketCount: readTickets().length,
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

app.get("/api/tickets/list", requireTicketAdmin, (req, res) => {
  res.json({
    ok: true,
    tickets: readTickets(),
  });
});

app.post("/api/tickets/create", requireTicketAdmin, (req, res) => {
  const tickets = readTickets();

  const buyerName = String(req.body?.buyerName || req.body?.name || "Guest").trim();
  const buyerEmail = String(req.body?.buyerEmail || req.body?.email || "").trim().toLowerCase();
  const eventName = String(req.body?.eventName || req.body?.event || "AGV Live Event").trim();
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
    createdAt: new Date().toISOString(),
  };

  tickets.unshift(ticket);
  writeTickets(tickets);

  res.status(201).json({
    ok: true,
    ticket,
    tickets,
  });
});

app.post("/api/tickets/verify", (req, res) => {
  const code = String(req.body?.code || req.body?.ticketCode || "").trim().toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      error: "Ticket code is required.",
      message: "Enter your ticket code.",
    });
  }

  const tickets = readTickets();
  const ticket = tickets.find((item) => String(item.code || "").trim().toUpperCase() === code);

  if (!ticket) {
    return res.status(404).json({
      ok: false,
      error: "Ticket not found.",
      message: "Ticket failed.",
    });
  }

  ticket.used = true;
  ticket.checkedIn = true;
  ticket.lastVerifiedAt = new Date().toISOString();

  writeTickets(tickets);

  res.json({
    ok: true,
    verified: true,
    ticket,
    roomId: ticket.roomId || "main-hall",
    message: "Ticket approved.",
  });
});

app.post("/api/tickets/reset", requireTicketAdmin, (req, res) => {
  writeTickets([]);

  res.json({
    ok: true,
    message: "All tickets cleared.",
    tickets: [],
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
  console.log("DATA FILE:", DATA_FILE);
  console.log("ADMIN PIN CONFIGURED:", Boolean(ADMIN_PIN));
  console.log("ADMIN PIN LENGTH:", ADMIN_PIN.length);
});