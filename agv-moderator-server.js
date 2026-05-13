const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = 8789;
const DATA_FILE = path.join(__dirname, "agv-moderators.json");

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

    if (!data.rooms) data.rooms = {};
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
    data.rooms[roomId] = {
      moderators: [],
    };
  }

  if (!Array.isArray(data.rooms[roomId].moderators)) {
    data.rooms[roomId].moderators = [];
  }

  return data.rooms[roomId];
}

function cleanText(value) {
  return String(value || "").trim();
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Moderator Server",
    port: PORT,
  });
});

app.get("/api/moderators/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const data = readData();
  const room = ensureRoom(data, roomId);

  res.json({
    ok: true,
    roomId,
    moderators: room.moderators,
  });
});

app.post("/api/moderators/:roomId/add", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const name = cleanText(req.body.name);
  const email = cleanText(req.body.email);

  if (!name && !email) {
    return res.status(400).json({
      ok: false,
      error: "Moderator name or email is required.",
    });
  }

  const data = readData();
  const room = ensureRoom(data, roomId);

  const moderator = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || email,
    email,
    createdAt: new Date().toISOString(),
  };

  room.moderators.push(moderator);
  writeData(data);

  res.json({
    ok: true,
    roomId,
    moderator,
    moderators: room.moderators,
  });
});

app.post("/api/moderators/:roomId/remove", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const moderatorId = cleanText(req.body.moderatorId);

  const data = readData();
  const room = ensureRoom(data, roomId);

  room.moderators = room.moderators.filter((mod) => mod.id !== moderatorId);
  writeData(data);

  res.json({
    ok: true,
    roomId,
    moderators: room.moderators,
  });
});

app.listen(PORT, () => {
  console.log("AGV MODERATOR SERVER RUNNING ON", PORT);
  console.log("MODERATOR DATA FILE:", DATA_FILE);
});