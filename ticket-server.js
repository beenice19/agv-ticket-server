const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8790;
const DATA_FILE = path.join(__dirname, "agv-tickets.json");

const ADMIN_PIN = process.env.AGV_TICKET_ADMIN_PIN || "AGV-TICKET-2026";

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function createTicketCode() {
  return `AGV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function defaultData() {
  return {
    tickets: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const data = defaultData();
      writeData(data);
      return data;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data.tickets)) {
      data.tickets = [];
    }

    return data;
  } catch {
    const data = defaultData();
    writeData(data);
    return data;
  }
}

function writeData(data) {
  const safeData = data && typeof data === "object" ? data : defaultData();

  if (!Array.isArray(safeData.tickets)) {
    safeData.tickets = [];
  }

  safeData.updatedAt = nowIso();

  fs.writeFileSync(DATA_FILE, JSON.stringify(safeData, null, 2), "utf8");
}

function getAdminPin(req) {
  return cleanText(
    req.headers["x-agv-admin-pin"] ||
      req.headers["x-admin-pin"] ||
      req.body?.adminPin ||
      req.query?.adminPin
  );
}

function requireAdmin(req, res, next) {
  const providedPin = getAdminPin(req);

  if (!providedPin) {
    return res.status(401).json({
      ok: false,
      message: "Admin PIN required.",
    });
  }

  if (providedPin !== ADMIN_PIN) {
    return res.status(401).json({
      ok: false,
      message: "Unauthorized. Invalid admin PIN.",
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    status: "online",
    port: PORT,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Ticket Server",
    port: PORT,
    ticketAdminConfigured: Boolean(ADMIN_PIN),
    dataFile: DATA_FILE,
  });
});

app.get("/api/tickets/list", requireAdmin, (req, res) => {
  const data = readData();

  res.json({
    ok: true,
    tickets: data.tickets,
    count: data.tickets.length,
  });
});

app.post("/api/tickets/create", requireAdmin, (req, res) => {
  const buyerName = cleanText(req.body.buyerName || req.body.name);
  const buyerEmail = cleanEmail(req.body.buyerEmail || req.body.email);
  const eventName = cleanText(req.body.eventName || req.body.event || "AGV Live Event");
  const roomId = cleanText(req.body.roomId || req.body.room || "main-hall");

  if (!buyerName) {
    return res.status(400).json({
      ok: false,
      message: "Buyer name is required.",
    });
  }

  if (!buyerEmail) {
    return res.status(400).json({
      ok: false,
      message: "Buyer email is required.",
    });
  }

  const data = readData();

  let code = createTicketCode();

  while (data.tickets.some((ticket) => ticket.code === code)) {
    code = createTicketCode();
  }

  const ticket = {
    id: `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    code,
    buyerName,
    buyerEmail,
    eventName,
    roomId,
    used: false,
    redeemed: false,
    checkedIn: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  data.tickets.unshift(ticket);
  writeData(data);

  res.json({
    ok: true,
    ticket,
    tickets: data.tickets,
  });
});

app.post("/api/tickets/verify", (req, res) => {
  const code = cleanText(req.body.code).toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      message: "Ticket code is required.",
    });
  }

  const data = readData();
  const ticket = data.tickets.find((item) => String(item.code || "").toUpperCase() === code);

  if (!ticket) {
    return res.status(404).json({
      ok: false,
      message: "Ticket not found.",
    });
  }

  if (ticket.used || ticket.redeemed || ticket.checkedIn) {
    return res.status(409).json({
      ok: false,
      message: "Ticket has already been used.",
      ticket,
    });
  }

  ticket.used = true;
  ticket.redeemed = true;
  ticket.checkedIn = true;
  ticket.usedAt = nowIso();
  ticket.updatedAt = nowIso();

  writeData(data);

  res.json({
    ok: true,
    message: "Ticket approved.",
    ticket,
  });
});

app.post("/api/tickets/reset", requireAdmin, (req, res) => {
  const code = cleanText(req.body.code).toUpperCase();

  if (!code) {
    return res.status(400).json({
      ok: false,
      message: "Ticket code is required.",
    });
  }

  const data = readData();
  const ticket = data.tickets.find((item) => String(item.code || "").toUpperCase() === code);

  if (!ticket) {
    return res.status(404).json({
      ok: false,
      message: "Ticket not found.",
    });
  }

  ticket.used = false;
  ticket.redeemed = false;
  ticket.checkedIn = false;
  ticket.usedAt = "";
  ticket.updatedAt = nowIso();

  writeData(data);

  res.json({
    ok: true,
    message: "Ticket reset.",
    ticket,
    tickets: data.tickets,
  });
});

app.listen(PORT, () => {
  console.log("AGV TICKET SERVER RUNNING ON", PORT);
  console.log("TICKET DATA FILE:", DATA_FILE);
  console.log("TICKET ADMIN PIN: CONFIGURED");
});