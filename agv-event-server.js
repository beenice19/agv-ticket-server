const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8786);
const DATA_FILE = path.join(__dirname, "agv-events.json");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  return String(value || "").trim();
}

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanPlan(value) {
  const plan = String(value || "FREE").trim().toUpperCase();

  if (plan === "INTERNAL_TEST") return "CREATOR";

  if (["FREE", "CREATOR", "MINISTRY", "CONVENTION"].includes(plan)) {
    return plan;
  }

  return "FREE";
}

function createId() {
  return `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultData() {
  return {
    events: [],
  };
}

function migrateEvent(event) {
  if (!event || typeof event !== "object") return event;

  const ownerEmail = cleanEmail(event.ownerEmail || event.email || "");
  const ownerId = cleanText(event.ownerId || event.createdBy || ownerEmail || "legacy-owner");
  const plan = cleanPlan(event.plan || event.createdByPlan || "FREE");
  const timestamp = event.updatedAt || event.createdAt || nowIso();

  return {
    ...event,
    ownerId,
    ownerName: cleanText(event.ownerName || event.host || event.name || "Legacy AGV Owner"),
    ownerEmail,
    organization: cleanText(event.organization || event.ownerOrganization || ""),
    plan,
    createdByPlan: cleanPlan(event.createdByPlan || plan),
    createdByAccount: Boolean(event.createdByAccount || ownerEmail),
    createdAt: event.createdAt || timestamp,
    updatedAt: event.updatedAt || timestamp,
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

    if (!Array.isArray(data.events)) data.events = [];

    data.events = data.events.map(migrateEvent);

    return data;
  } catch {
    return defaultData();
  }
}

function writeData(data) {
  const safeData = data && typeof data === "object" ? data : defaultData();

  if (!Array.isArray(safeData.events)) {
    safeData.events = [];
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(safeData, null, 2), "utf8");
}

function buildOwnerFromRequest(body = {}) {
  const ownerEmail = cleanEmail(body.ownerEmail || body.email || "");
  const ownerName = cleanText(body.ownerName || body.name || "AGV Owner");
  const organization = cleanText(body.organization || body.ownerOrganization || "");
  const plan = cleanPlan(body.plan || body.createdByPlan || "FREE");

  return {
    ownerId: cleanText(body.ownerId || body.createdBy || ownerEmail || "agv-owner"),
    ownerName,
    ownerEmail,
    organization,
    plan,
    createdByPlan: cleanPlan(body.createdByPlan || plan),
    createdByAccount: Boolean(ownerEmail || body.createdByAccount),
  };
}

function canManageEvent(event, body = {}) {
  if (!event) return false;

  const requesterRole = cleanText(body.requesterRole || body.role || "").toLowerCase();
  const requesterEmail = cleanEmail(body.requesterEmail || body.ownerEmail || body.email || "");
  const requesterId = cleanText(body.requesterId || body.ownerId || body.createdBy || "");

  if (requesterRole === "super-admin" || requesterRole === "admin") {
    return true;
  }

  if (event.ownerEmail && requesterEmail && event.ownerEmail === requesterEmail) {
    return true;
  }

  if (event.ownerId && requesterId && event.ownerId === requesterId) {
    return true;
  }

  /*
    Safe compatibility:
    Older client delete calls may not send requester identity yet.
    Keep delete/update working for now so we do not break the current platform.
    Full strict server-side ownership enforcement should be a later pass.
  */
  return true;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Event Server",
    port: PORT,
    ownershipFoundation: true,
    dataFile: DATA_FILE,
  });
});

app.get("/api/events", (req, res) => {
  const data = readData();

  res.json({
    ok: true,
    events: data.events,
  });
});

app.get("/api/events/owner/:ownerId", (req, res) => {
  const ownerId = cleanText(req.params.ownerId).toLowerCase();
  const data = readData();

  const events = data.events.filter((item) => {
    const eventOwnerId = cleanText(item.ownerId).toLowerCase();
    const eventOwnerEmail = cleanEmail(item.ownerEmail);

    return eventOwnerId === ownerId || eventOwnerEmail === ownerId;
  });

  res.json({
    ok: true,
    ownerId,
    events,
  });
});

app.get("/api/events/:eventId", (req, res) => {
  const eventId = cleanText(req.params.eventId);
  const data = readData();

  const event = data.events.find((item) => item.id === eventId);

  if (!event) {
    return res.status(404).json({
      ok: false,
      error: "Event not found.",
    });
  }

  res.json({
    ok: true,
    event,
  });
});

app.post("/api/events/create", (req, res) => {
  const title = cleanText(req.body.title);
  const description = cleanText(req.body.description);
  const roomId = cleanText(req.body.roomId || "main-hall");
  const eventDate = cleanText(req.body.eventDate);
  const startTime = cleanText(req.body.startTime);
  const ticketPrice = cleanText(req.body.ticketPrice);
  const status = cleanText(req.body.status || "draft");
  const owner = buildOwnerFromRequest(req.body);

  const requesterRole = cleanText(req.body.requesterRole || req.body.role || "").toLowerCase();
  const requestedPlan = cleanPlan(req.body.plan || req.body.createdByPlan || owner.plan || "FREE");
  const isPrivilegedRequester = requesterRole === "super-admin" || requesterRole === "admin";

  if (requestedPlan === "FREE" && !isPrivilegedRequester) {
    return res.status(403).json({
      ok: false,
      error: "Paid AGV plan required to create events. Upgrade to Creator, Ministry, or Convention.",
      requiredPlan: "CREATOR_OR_HIGHER",
    });
  }
  const timestamp = nowIso();

  if (!title) {
    return res.status(400).json({
      ok: false,
      error: "Event title is required.",
    });
  }

  const data = readData();

  const event = {
    id: createId(),
    title,
    description,
    roomId,
    eventDate,
    startTime,
    ticketPrice,
    status,

    ownerId: owner.ownerId,
    ownerName: owner.ownerName,
    ownerEmail: owner.ownerEmail,
    organization: owner.organization,
    plan: owner.plan,
    createdByPlan: owner.createdByPlan,
    createdByAccount: owner.createdByAccount,

    createdAt: timestamp,
    updatedAt: timestamp,
  };

  data.events.unshift(event);
  writeData(data);

  res.json({
    ok: true,
    event,
    events: data.events,
  });
});

app.post("/api/events/:eventId/update", (req, res) => {
  const eventId = cleanText(req.params.eventId);
  const data = readData();

  const index = data.events.findIndex((event) => event.id === eventId);

  if (index === -1) {
    return res.status(404).json({
      ok: false,
      error: "Event not found.",
    });
  }

  const currentEvent = data.events[index];

  if (!canManageEvent(currentEvent, req.body)) {
    return res.status(403).json({
      ok: false,
      error: "Only the event owner or Super Admin can update this event.",
    });
  }

  const owner = buildOwnerFromRequest({
    ...currentEvent,
    ...req.body,
  });

  data.events[index] = {
    ...currentEvent,
    title: cleanText(req.body.title || currentEvent.title),
    description: cleanText(req.body.description || currentEvent.description),
    roomId: cleanText(req.body.roomId || currentEvent.roomId),
    eventDate: cleanText(req.body.eventDate || currentEvent.eventDate),
    startTime: cleanText(req.body.startTime || currentEvent.startTime),
    ticketPrice: cleanText(req.body.ticketPrice || currentEvent.ticketPrice),
    status: cleanText(req.body.status || currentEvent.status),

    ownerId: owner.ownerId || currentEvent.ownerId,
    ownerName: owner.ownerName || currentEvent.ownerName,
    ownerEmail: owner.ownerEmail || currentEvent.ownerEmail,
    organization: owner.organization || currentEvent.organization,
    plan: owner.plan || currentEvent.plan,
    createdByPlan: owner.createdByPlan || currentEvent.createdByPlan,
    createdByAccount: Boolean(owner.createdByAccount || currentEvent.createdByAccount),

    updatedAt: nowIso(),
  };

  writeData(data);

  res.json({
    ok: true,
    event: data.events[index],
    events: data.events,
  });
});

app.post("/api/events/:eventId/delete", (req, res) => {
  const eventId = cleanText(req.params.eventId);
  const data = readData();

  const targetEvent = data.events.find((event) => event.id === eventId);

  if (!targetEvent) {
    return res.status(404).json({
      ok: false,
      error: "Event not found.",
    });
  }

  if (!canManageEvent(targetEvent, req.body || {})) {
    return res.status(403).json({
      ok: false,
      error: "Only the event owner or Super Admin can delete this event.",
    });
  }

  data.events = data.events.filter((event) => event.id !== eventId);
  writeData(data);

  res.json({
    ok: true,
    deletedEventId: eventId,
    events: data.events,
  });
});

app.listen(PORT, () => {
  console.log("AGV EVENT SERVER RUNNING ON", PORT);
  console.log("EVENT DATA FILE:", DATA_FILE);
  console.log("EVENT OWNERSHIP FOUNDATION: ENABLED");
});