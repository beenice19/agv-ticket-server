const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = 8785;
const DATA_FILE = path.join(__dirname, "agv-bulletins.json");

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

function cleanText(value) {
  return String(value || "").trim();
}

function ensureRoom(data, roomId) {
  if (!data.rooms[roomId]) {
    data.rooms[roomId] = {
      bulletins: [
        "Welcome to Avant Global Vision.",
        "The host will begin the broadcast shortly.",
        "Viewer controls are locked for a clean audience experience.",
      ],
    };
  }

  if (!Array.isArray(data.rooms[roomId].bulletins)) {
    data.rooms[roomId].bulletins = [];
  }

  return data.rooms[roomId];
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Bulletin Server",
    port: PORT,
  });
});

app.get("/api/bulletins/:roomId", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const data = readData();
  const room = ensureRoom(data, roomId);

  writeData(data);

  res.json({
    ok: true,
    roomId,
    bulletins: room.bulletins,
  });
});

app.post("/api/bulletins/:roomId/add", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const text = cleanText(req.body.text);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Bulletin text is required.",
    });
  }

  const data = readData();
  const room = ensureRoom(data, roomId);

  room.bulletins.push(text);
  writeData(data);

  res.json({
    ok: true,
    roomId,
    bulletins: room.bulletins,
  });
});

app.post("/api/bulletins/:roomId/clear", (req, res) => {
  const roomId = cleanText(req.params.roomId || "main-hall");
  const data = readData();
  const room = ensureRoom(data, roomId);

  room.bulletins = [];
  writeData(data);

  res.json({
    ok: true,
    roomId,
    bulletins: room.bulletins,
  });
});

app.listen(PORT, () => {
  console.log("AGV BULLETIN SERVER RUNNING ON", PORT);
  console.log("BULLETIN DATA FILE:", DATA_FILE);
});