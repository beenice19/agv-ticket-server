const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = 8788;
const DATA_FILE = path.join(__dirname, "agv-chat-data.json");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { rooms: {} };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!data || typeof data !== "object") return { rooms: {} };
    if (!data.rooms || typeof data.rooms !== "object") data.rooms = {};

    return data;
  } catch {
    return { rooms: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function ensureRoom(data, roomId) {
  if (!data.rooms[roomId]) {
    data.rooms[roomId] = { messages: [] };
  }

  if (!Array.isArray(data.rooms[roomId].messages)) {
    data.rooms[roomId].messages = [];
  }

  return data.rooms[roomId];
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "AGV Chat Server", port: PORT });
});

app.get("/api/chat/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "main-hall");
  const data = readData();
  const room = ensureRoom(data, roomId);

  res.json({
    ok: true,
    roomId,
    messages: room.messages.slice(-200),
  });
});

app.post("/api/chat/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "main-hall");
  const text = String(req.body?.text || "").trim();
  const sender = String(req.body?.sender || "Guest").trim();
  const role = String(req.body?.role || "viewer").trim();

  if (!text) {
    return res.status(400).json({ ok: false, error: "Message text is required." });
  }

  const data = readData();
  const room = ensureRoom(data, roomId);

  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sender,
    role,
    text,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    createdAt: new Date().toISOString(),
  };

  room.messages.push(message);
  room.messages = room.messages.slice(-500);

  writeData(data);

  res.json({
    ok: true,
    roomId,
    message,
    messages: room.messages.slice(-200),
  });
});

app.post("/api/chat/:roomId/clear", (req, res) => {
  const roomId = String(req.params.roomId || "main-hall");
  const data = readData();
  const room = ensureRoom(data, roomId);

  room.messages = [];
  writeData(data);

  res.json({ ok: true, roomId, messages: [] });
});

app.listen(PORT, () => {
  console.log("AGV CHAT SERVER RUNNING ON", PORT);
  console.log("CHAT DATA FILE:", DATA_FILE);
});