const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = 8786;
const DATA_FILE = path.join(__dirname, "agv-events.json");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { events: [] };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data.events)) data.events = [];

    return data;
  } catch {
    return { events: [] };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function cleanText(value) {
  return String(value || "").trim();
}

function createId() {
  return `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Event Server",
    port: PORT,
  });
});

app.get("/api/events", (req, res) => {
  const data = readData();

  res.json({
    ok: true,
    events: data.events,
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

  data.events[index] = {
    ...data.events[index],
    title: cleanText(req.body.title || data.events[index].title),
    description: cleanText(req.body.description || data.events[index].description),
    roomId: cleanText(req.body.roomId || data.events[index].roomId),
    eventDate: cleanText(req.body.eventDate || data.events[index].eventDate),
    startTime: cleanText(req.body.startTime || data.events[index].startTime),
    ticketPrice: cleanText(req.body.ticketPrice || data.events[index].ticketPrice),
    status: cleanText(req.body.status || data.events[index].status),
    updatedAt: new Date().toISOString(),
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

  data.events = data.events.filter((event) => event.id !== eventId);
  writeData(data);

  res.json({
    ok: true,
    events: data.events,
  });
});

app.listen(PORT, () => {
  console.log("AGV EVENT SERVER RUNNING ON", PORT);
  console.log("EVENT DATA FILE:", DATA_FILE);
});