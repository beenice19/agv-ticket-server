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

function normalizePlan(plan) {
  const cleanPlan = String(plan || "FREE").trim().toUpperCase();

  if (cleanPlan === "INTERNAL_TEST") {
    return "CREATOR";
  }

  if (!PLAN_LIMITS[cleanPlan]) {
    return "FREE";
  }

  return cleanPlan;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return number;
}

function defaultData() {
  const createdAt = nowIso();

  return {
    organizationId: "agv-demo",
    plan: "FREE",
    updatedAt: createdAt,

    account: {
      accountId: "agv-demo",
      name: "",
      email: "",
      organization: "",
      role: "owner",
      plan: "FREE",
      createdAt,
      updatedAt: createdAt,
      lastLoginAt: "",
    },

    accounts: {},
  };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function migrateData(data) {
  const migrated = data && typeof data === "object" ? data : defaultData();

  if (!migrated.organizationId) {
    migrated.organizationId = "agv-demo";
  }

  migrated.plan = normalizePlan(migrated.plan);

  if (!migrated.updatedAt) {
    migrated.updatedAt = nowIso();
  }

  if (!migrated.account || typeof migrated.account !== "object") {
    migrated.account = {
      accountId: migrated.organizationId || "agv-demo",
      name: "",
      email: "",
      organization: "",
      role: "owner",
      plan: migrated.plan,
      createdAt: migrated.updatedAt || nowIso(),
      updatedAt: migrated.updatedAt || nowIso(),
      lastLoginAt: "",
    };
  }

  migrated.account.plan = normalizePlan(migrated.account.plan || migrated.plan);
  migrated.account.accountId = migrated.account.accountId || migrated.organizationId || "agv-demo";
  migrated.account.name = migrated.account.name || "";
  migrated.account.email = normalizeEmail(migrated.account.email);
  migrated.account.organization = migrated.account.organization || "";
  migrated.account.role = migrated.account.role || "owner";
  migrated.account.createdAt = migrated.account.createdAt || migrated.updatedAt || nowIso();
  migrated.account.updatedAt = migrated.account.updatedAt || migrated.updatedAt || nowIso();
  migrated.account.lastLoginAt = migrated.account.lastLoginAt || "";

  if (!migrated.accounts || typeof migrated.accounts !== "object") {
    migrated.accounts = {};
  }

  if (migrated.account.email) {
    migrated.accounts[migrated.account.email] = {
      ...migrated.accounts[migrated.account.email],
      ...migrated.account,
      email: migrated.account.email,
      plan: migrated.account.plan,
    };
  }

  return migrated;
}

function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const data = defaultData();
      writeData(data);
      return data;
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const data = migrateData(parsed);

    return data;
  } catch {
    const data = defaultData();
    writeData(data);
    return data;
  }
}

function getPrimaryAccount(data) {
  const safeData = migrateData(data || readData());

  if (safeData.account?.email) {
    return safeData.account;
  }

  const accountValues = Object.values(safeData.accounts || {});

  if (accountValues.length) {
    return accountValues[0];
  }

  return safeData.account;
}

function getAccountByEmail(email) {
  const cleanEmail = normalizeEmail(email);
  const data = readData();

  if (!cleanEmail) {
    return getPrimaryAccount(data);
  }

  return data.accounts?.[cleanEmail] || null;
}

function resolvePlanForRequest(body = {}) {
  const data = readData();
  const email = normalizeEmail(body.email || body.ownerEmail || body.requesterEmail || "");
  const requestedPlan = normalizePlan(body.plan || "");

  if (email && data.accounts?.[email]?.plan) {
    return normalizePlan(data.accounts[email].plan);
  }

  if (email && data.account?.email === email && data.account?.plan) {
    return normalizePlan(data.account.plan);
  }

  if (body.plan) {
    return requestedPlan;
  }

  if (data.account?.plan) {
    return normalizePlan(data.account.plan);
  }

  return normalizePlan(data.plan);
}

function buildEnforcementResponse({
  allowed,
  plan,
  check,
  reason,
  currentValue,
  requestedValue,
}) {
  const normalizedPlan = normalizePlan(plan);
  const limits = PLAN_LIMITS[normalizedPlan] || PLAN_LIMITS.FREE;

  return {
    ok: true,
    allowed: Boolean(allowed),
    check,
    reason,
    plan: normalizedPlan,
    limits,
    currentValue,
    requestedValue,
    checkedAt: nowIso(),
  };
}

function checkRoomCreate(body = {}) {
  const plan = resolvePlanForRequest(body);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
  const currentRooms = toNumber(body.currentRooms, 0);
  const requestedRooms = toNumber(body.requestedRooms, currentRooms + 1);

  const allowed = requestedRooms <= limits.maxRooms;

  return buildEnforcementResponse({
    allowed,
    plan,
    check: "room-create",
    currentValue: currentRooms,
    requestedValue: requestedRooms,
    reason: allowed
      ? `${limits.label} plan allows up to ${limits.maxRooms} room(s).`
      : `${limits.label} plan allows ${limits.maxRooms} room(s). Upgrade required to create more rooms.`,
  });
}

function checkPrivateRoom(body = {}) {
  const plan = resolvePlanForRequest(body);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
  const wantsPrivate = Boolean(body.isPrivate || body.privateRoom || body.requestPrivate);

  const allowed = !wantsPrivate || Boolean(limits.allowPrivate);

  return buildEnforcementResponse({
    allowed,
    plan,
    check: "private-room",
    currentValue: wantsPrivate,
    requestedValue: wantsPrivate,
    reason: allowed
      ? `${limits.label} plan private-room check passed.`
      : `${limits.label} plan does not allow private rooms. Upgrade required.`,
  });
}

function checkTicketOnly(body = {}) {
  const plan = resolvePlanForRequest(body);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
  const wantsTicketOnly = Boolean(body.isTicketOnly || body.ticketOnly || body.requestTicketOnly);

  const allowed = !wantsTicketOnly || Boolean(limits.allowTicketOnly);

  return buildEnforcementResponse({
    allowed,
    plan,
    check: "ticket-only",
    currentValue: wantsTicketOnly,
    requestedValue: wantsTicketOnly,
    reason: allowed
      ? `${limits.label} plan ticket-only check passed.`
      : `${limits.label} plan does not allow ticket-only rooms. Upgrade required.`,
  });
}

function checkViewerCapacity(body = {}) {
  const plan = resolvePlanForRequest(body);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
  const currentViewers = toNumber(body.currentViewers, 0);
  const requestedViewers = toNumber(body.requestedViewers, currentViewers + 1);

  const allowed = requestedViewers <= limits.maxViewers;

  return buildEnforcementResponse({
    allowed,
    plan,
    check: "viewer-capacity",
    currentValue: currentViewers,
    requestedValue: requestedViewers,
    reason: allowed
      ? `${limits.label} plan allows up to ${limits.maxViewers} viewer(s).`
      : `${limits.label} plan allows ${limits.maxViewers} viewer(s). Upgrade required for more viewers.`,
  });
}

function checkFeature(body = {}) {
  const feature = String(body.feature || "").trim().toLowerCase();

  if (feature === "room-create") return checkRoomCreate(body);
  if (feature === "private-room") return checkPrivateRoom(body);
  if (feature === "ticket-only") return checkTicketOnly(body);
  if (feature === "viewer-capacity") return checkViewerCapacity(body);

  const plan = resolvePlanForRequest(body);

  return buildEnforcementResponse({
    allowed: false,
    plan,
    check: feature || "unknown-feature",
    currentValue: null,
    requestedValue: null,
    reason: "Unknown plan enforcement feature check.",
  });
}

function getSubscriptionPayload() {
  const data = readData();
  const plan = normalizePlan(data.plan);
  const account = getPrimaryAccount(data);

  return {
    ok: true,
    organizationId: data.organizationId,
    plan,
    limits: PLAN_LIMITS[plan],
    updatedAt: data.updatedAt,
    enforcement: {
      enabled: true,
      mode: "advisory",
      checks: [
        "room-create",
        "private-room",
        "ticket-only",
        "viewer-capacity",
      ],
    },
    account: {
      accountId: account.accountId || data.organizationId || "agv-demo",
      name: account.name || "",
      email: account.email || "",
      organization: account.organization || "",
      role: account.role || "owner",
      plan: normalizePlan(account.plan || plan),
      createdAt: account.createdAt || "",
      updatedAt: account.updatedAt || "",
      lastLoginAt: account.lastLoginAt || "",
    },
  };
}

function upsertAccount(input = {}) {
  const data = readData();

  const cleanEmail = normalizeEmail(input.email || data.account?.email || "");
  const cleanPlan = normalizePlan(input.plan || data.plan || "FREE");
  const timestamp = nowIso();

  const existingAccount =
    cleanEmail && data.accounts?.[cleanEmail]
      ? data.accounts[cleanEmail]
      : data.account || {};

  const accountId =
    existingAccount.accountId ||
    cleanEmail ||
    data.organizationId ||
    "agv-demo";

  const nextAccount = {
    accountId,
    name: String(input.name || existingAccount.name || "").trim(),
    email: cleanEmail,
    organization: String(input.organization || existingAccount.organization || "").trim(),
    role: String(input.role || existingAccount.role || "owner").trim() || "owner",
    plan: cleanPlan,
    createdAt: existingAccount.createdAt || timestamp,
    updatedAt: timestamp,
    lastLoginAt: input.markLogin ? timestamp : existingAccount.lastLoginAt || "",
  };

  data.organizationId = nextAccount.accountId || data.organizationId || "agv-demo";
  data.plan = cleanPlan;
  data.updatedAt = timestamp;
  data.account = nextAccount;

  if (!data.accounts || typeof data.accounts !== "object") {
    data.accounts = {};
  }

  if (cleanEmail) {
    data.accounts[cleanEmail] = nextAccount;
  }

  writeData(data);

  return {
    ok: true,
    account: nextAccount,
    subscription: getSubscriptionPayload(),
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Subscription + Account Server",
    port: PORT,
    dataFile: DATA_FILE,
    enforcement: true,
  });
});

app.get("/api/subscription", (req, res) => {
  res.json(getSubscriptionPayload());
});

app.post("/api/subscription/plan", (req, res) => {
  const requestedPlan = normalizePlan(req.body.plan);

  if (!PLAN_LIMITS[requestedPlan]) {
    return res.status(400).json({
      ok: false,
      error: "Invalid subscription plan.",
      allowedPlans: Object.keys(PLAN_LIMITS),
    });
  }

  const data = readData();
  const timestamp = nowIso();

  data.plan = requestedPlan;
  data.updatedAt = timestamp;

  if (data.account) {
    data.account.plan = requestedPlan;
    data.account.updatedAt = timestamp;

    if (data.account.email) {
      if (!data.accounts || typeof data.accounts !== "object") {
        data.accounts = {};
      }

      data.accounts[data.account.email] = {
        ...data.accounts[data.account.email],
        ...data.account,
        plan: requestedPlan,
        updatedAt: timestamp,
      };
    }
  }

  writeData(data);

  res.json(getSubscriptionPayload());
});

app.get("/api/subscription/plans", (req, res) => {
  res.json({
    ok: true,
    plans: PLAN_LIMITS,
  });
});

app.post("/api/subscription/check-room-create", (req, res) => {
  res.json(checkRoomCreate(req.body || {}));
});

app.post("/api/subscription/check-private-room", (req, res) => {
  res.json(checkPrivateRoom(req.body || {}));
});

app.post("/api/subscription/check-ticket-only", (req, res) => {
  res.json(checkTicketOnly(req.body || {}));
});

app.post("/api/subscription/check-viewer-capacity", (req, res) => {
  res.json(checkViewerCapacity(req.body || {}));
});

app.post("/api/subscription/check-feature", (req, res) => {
  res.json(checkFeature(req.body || {}));
});

app.get("/api/account", (req, res) => {
  const email = normalizeEmail(req.query.email);
  const account = getAccountByEmail(email);

  if (!account) {
    return res.status(404).json({
      ok: false,
      error: "Account not found.",
    });
  }

  res.json({
    ok: true,
    account,
  });
});

app.post("/api/account/upsert", (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!email) {
    return res.status(400).json({
      ok: false,
      error: "Email is required to create or update an AGV account.",
    });
  }

  const result = upsertAccount({
    name: req.body.name,
    email,
    organization: req.body.organization,
    role: req.body.role || "owner",
    plan: req.body.plan || "FREE",
    markLogin: Boolean(req.body.markLogin),
  });

  res.json(result);
});

app.listen(PORT, () => {
  console.log("AGV SUBSCRIPTION + ACCOUNT SERVER RUNNING ON", PORT);
  console.log("SUBSCRIPTION DATA FILE:", DATA_FILE);
  console.log("ACCOUNT FOUNDATION: ENABLED");
  console.log("PLAN ENFORCEMENT FOUNDATION: ENABLED");
});