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

function cleanText(value) {
  return String(value || "").trim();
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

function buildBillingIdentity(input = {}, existing = {}) {
  const timestamp = nowIso();

  const stripeCustomerId = cleanText(
    input.stripeCustomerId ||
      input.stripe_customer_id ||
      existing.stripeCustomerId ||
      existing.stripe_customer_id ||
      ""
  );

  const stripeSubscriptionId = cleanText(
    input.stripeSubscriptionId ||
      input.stripe_subscription_id ||
      existing.stripeSubscriptionId ||
      existing.stripe_subscription_id ||
      ""
  );

  const stripeCheckoutSessionId = cleanText(
    input.stripeCheckoutSessionId ||
      input.stripe_checkout_session_id ||
      existing.stripeCheckoutSessionId ||
      existing.stripe_checkout_session_id ||
      ""
  );

  const billingStatus = cleanText(
    input.billingStatus ||
      input.billing_status ||
      existing.billingStatus ||
      existing.billing_status ||
      ""
  );

  const lastBillingSyncAt =
    input.lastBillingSyncAt ||
    input.last_billing_sync_at ||
    existing.lastBillingSyncAt ||
    existing.last_billing_sync_at ||
    (stripeCustomerId || stripeSubscriptionId || stripeCheckoutSessionId || billingStatus
      ? timestamp
      : "");

  return {
    stripeCustomerId,
    stripeSubscriptionId,
    stripeCheckoutSessionId,
    billingStatus,
    lastBillingSyncAt,
  };
}

function defaultAccount(createdAt, plan = "FREE") {
  return {
    accountId: "agv-demo",
    name: "",
    email: "",
    organization: "",
    role: "owner",
    plan,
    createdAt,
    updatedAt: createdAt,
    lastLoginAt: "",
    stripeCustomerId: "",
    stripeSubscriptionId: "",
    stripeCheckoutSessionId: "",
    billingStatus: "",
    lastBillingSyncAt: "",
  };
}

function defaultData() {
  const createdAt = nowIso();

  return {
    organizationId: "agv-demo",
    plan: "FREE",
    updatedAt: createdAt,
    account: defaultAccount(createdAt, "FREE"),
    accounts: {},
  };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function migrateAccount(account = {}, fallback = {}) {
  const timestamp = nowIso();
  const plan = normalizePlan(account.plan || fallback.plan || "FREE");
  const billing = buildBillingIdentity(account, account);

  return {
    accountId:
      account.accountId ||
      account.account_id ||
      fallback.accountId ||
      fallback.organizationId ||
      account.email ||
      "agv-demo",
    name: cleanText(account.name || fallback.name || ""),
    email: normalizeEmail(account.email || fallback.email || ""),
    organization: cleanText(account.organization || fallback.organization || ""),
    role: cleanText(account.role || fallback.role || "owner") || "owner",
    plan,
    createdAt: account.createdAt || account.created_at || fallback.createdAt || timestamp,
    updatedAt: account.updatedAt || account.updated_at || fallback.updatedAt || timestamp,
    lastLoginAt: account.lastLoginAt || account.last_login_at || fallback.lastLoginAt || "",
    stripeCustomerId: billing.stripeCustomerId,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    stripeCheckoutSessionId: billing.stripeCheckoutSessionId,
    billingStatus: billing.billingStatus,
    lastBillingSyncAt: billing.lastBillingSyncAt,
  };
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
    migrated.account = defaultAccount(migrated.updatedAt || nowIso(), migrated.plan);
  }

  migrated.account = migrateAccount(migrated.account, {
    organizationId: migrated.organizationId,
    plan: migrated.plan,
    updatedAt: migrated.updatedAt,
  });

  if (!migrated.accounts || typeof migrated.accounts !== "object") {
    migrated.accounts = {};
  }

  Object.keys(migrated.accounts).forEach((emailKey) => {
    const cleanEmail = normalizeEmail(emailKey);
    const migratedAccount = migrateAccount(migrated.accounts[emailKey], {
      organizationId: migrated.organizationId,
      plan: migrated.plan,
      updatedAt: migrated.updatedAt,
    });

    if (cleanEmail && cleanEmail !== emailKey) {
      delete migrated.accounts[emailKey];
    }

    if (migratedAccount.email) {
      migrated.accounts[migratedAccount.email] = migratedAccount;
    } else if (cleanEmail) {
      migrated.accounts[cleanEmail] = {
        ...migratedAccount,
        email: cleanEmail,
      };
    }
  });

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
    return migrateData(parsed);
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

function publicAccountPayload(account = {}, fallbackPlan = "FREE") {
  const plan = normalizePlan(account.plan || fallbackPlan);

  return {
    accountId: account.accountId || account.email || "agv-demo",
    name: account.name || "",
    email: account.email || "",
    organization: account.organization || "",
    role: account.role || "owner",
    plan,
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || "",
    lastLoginAt: account.lastLoginAt || "",
    billing: {
      stripeCustomerId: account.stripeCustomerId || "",
      stripeSubscriptionId: account.stripeSubscriptionId || "",
      stripeCheckoutSessionId: account.stripeCheckoutSessionId || "",
      billingStatus: account.billingStatus || "",
      lastBillingSyncAt: account.lastBillingSyncAt || "",
      connected: Boolean(account.stripeCustomerId || account.stripeSubscriptionId),
    },
  };
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
    billingIdentity: {
      enabled: true,
      stripeCustomerId: account.stripeCustomerId || "",
      stripeSubscriptionId: account.stripeSubscriptionId || "",
      stripeCheckoutSessionId: account.stripeCheckoutSessionId || "",
      billingStatus: account.billingStatus || "",
      lastBillingSyncAt: account.lastBillingSyncAt || "",
      connected: Boolean(account.stripeCustomerId || account.stripeSubscriptionId),
    },
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
    account: publicAccountPayload(account, plan),
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

  const billing = buildBillingIdentity(input, existingAccount);

  const nextAccount = {
    accountId,
    name: cleanText(input.name || existingAccount.name || ""),
    email: cleanEmail,
    organization: cleanText(input.organization || existingAccount.organization || ""),
    role: cleanText(input.role || existingAccount.role || "owner") || "owner",
    plan: cleanPlan,
    createdAt: existingAccount.createdAt || timestamp,
    updatedAt: timestamp,
    lastLoginAt: input.markLogin ? timestamp : existingAccount.lastLoginAt || "",
    stripeCustomerId: billing.stripeCustomerId,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    stripeCheckoutSessionId: billing.stripeCheckoutSessionId,
    billingStatus: billing.billingStatus,
    lastBillingSyncAt: billing.lastBillingSyncAt,
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

function syncStripeCustomer(input = {}) {
  const email = normalizeEmail(input.email || input.customerEmail || input.accountEmail || "");

  if (!email) {
    return {
      ok: false,
      status: 400,
      error: "Email is required to sync Stripe customer data.",
    };
  }

  const plan = normalizePlan(input.plan || "FREE");
  const timestamp = nowIso();

  const result = upsertAccount({
    name: input.name,
    email,
    organization: input.organization,
    role: input.role || "owner",
    plan,
    markLogin: Boolean(input.markLogin),
    stripeCustomerId: input.stripeCustomerId || input.stripe_customer_id,
    stripeSubscriptionId: input.stripeSubscriptionId || input.stripe_subscription_id,
    stripeCheckoutSessionId:
      input.stripeCheckoutSessionId || input.stripe_checkout_session_id,
    billingStatus: input.billingStatus || input.billing_status || "active",
    lastBillingSyncAt: input.lastBillingSyncAt || timestamp,
  });

  return {
    ok: true,
    status: 200,
    account: result.account,
    subscription: result.subscription,
  };
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Subscription + Account Server",
    port: PORT,
    dataFile: DATA_FILE,
    enforcement: true,
    billingIdentity: true,
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

app.post("/api/subscription/sync-stripe-customer", (req, res) => {
  const result = syncStripeCustomer(req.body || {});

  if (!result.ok) {
    return res.status(result.status || 400).json({
      ok: false,
      error: result.error || "Stripe customer sync failed.",
    });
  }

  res.json({
    ok: true,
    account: result.account,
    subscription: result.subscription,
  });
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
    account: publicAccountPayload(account, account.plan),
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
    stripeCustomerId: req.body.stripeCustomerId || req.body.stripe_customer_id,
    stripeSubscriptionId:
      req.body.stripeSubscriptionId || req.body.stripe_subscription_id,
    stripeCheckoutSessionId:
      req.body.stripeCheckoutSessionId || req.body.stripe_checkout_session_id,
    billingStatus: req.body.billingStatus || req.body.billing_status,
    lastBillingSyncAt:
      req.body.lastBillingSyncAt || req.body.last_billing_sync_at,
  });

  res.json(result);
});

app.listen(PORT, () => {
  console.log("AGV SUBSCRIPTION + ACCOUNT SERVER RUNNING ON", PORT);
  console.log("SUBSCRIPTION DATA FILE:", DATA_FILE);
  console.log("ACCOUNT FOUNDATION: ENABLED");
  console.log("PLAN ENFORCEMENT FOUNDATION: ENABLED");
  console.log("STRIPE CUSTOMER FIELD FOUNDATION: ENABLED");
});