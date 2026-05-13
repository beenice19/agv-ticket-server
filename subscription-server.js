const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = 8792;
const DATA_FILE = path.join(__dirname, "agv-subscription.json");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

const PLAN_LIMITS = {
  FREE: {
    label: "Free",
    maxRooms: 1,
    maxViewers: 25,
    allowPrivate: false,
    allowTicketOnly: false,
  },

  CREATOR: {
    label: "Creator",
    maxRooms: 3,
    maxViewers: 100,
    allowPrivate: true,
    allowTicketOnly: true,
  },

  MINISTRY: {
    label: "Ministry / Pro",
    maxRooms: 10,
    maxViewers: 500,
    allowPrivate: true,
    allowTicketOnly: true,
  },

  CONVENTION: {
    label: "Convention",
    maxRooms: 50,
    maxViewers: 2000,
    allowPrivate: true,
    allowTicketOnly: true,
  },
};

function defaultData() {
  return {
    organizationId: "agv-demo",
    plan: "FREE",
    updatedAt: new Date().toISOString(),
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

    if (!data.organizationId) data.organizationId = "agv-demo";

    if (!data.plan || !PLAN_LIMITS[data.plan]) {
      data.plan = "FREE";
    }

    if (!data.updatedAt) {
      data.updatedAt = new Date().toISOString();
    }

    return data;
  } catch {
    const data = defaultData();
    writeData(data);
    return data;
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function getSubscriptionPayload() {
  const data = readData();

  return {
    ok: true,
    organizationId: data.organizationId,
    plan: data.plan,
    limits: PLAN_LIMITS[data.plan],
    updatedAt: data.updatedAt,
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Subscription Server",
    port: PORT,
  });
});

app.get("/api/subscription", (req, res) => {
  res.json(getSubscriptionPayload());
});

app.post("/api/subscription/plan", (req, res) => {
  const requestedPlan = String(req.body.plan || "")
    .trim()
    .toUpperCase();

  if (!PLAN_LIMITS[requestedPlan]) {
    return res.status(400).json({
      ok: false,
      error: "Invalid subscription plan.",
      allowedPlans: Object.keys(PLAN_LIMITS),
    });
  }

  const data = readData();

  data.plan = requestedPlan;
  data.updatedAt = new Date().toISOString();

  writeData(data);

  res.json(getSubscriptionPayload());
});

app.get("/api/subscription/plans", (req, res) => {
  res.json({
    ok: true,
    plans: PLAN_LIMITS,
  });
});

app.listen(PORT, () => {
  console.log("AGV SUBSCRIPTION SERVER RUNNING ON", PORT);
  console.log("SUBSCRIPTION DATA FILE:", DATA_FILE);
});