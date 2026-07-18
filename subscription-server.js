require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const {
  isSubscriptionPersistenceReady,
  loadSubscriptionState,
  saveSubscriptionState,
} = require("./lib/subscriptionPersistence");

const PORT = Number(process.env.PORT || 8792);
const DATA_FILE = path.join(__dirname, "agv-subscription.json");

// AGV_NETWORK_CONTROL_2_SERVER_REGISTRY
// Public reads are open. Writes require a verified AGV session whose email
// appears in the server-controlled AGV_SUPER_ADMIN_EMAILS environment variable.
const AGV_SUPER_ADMIN_EMAILS = new Set(
  String(process.env.AGV_SUPER_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

const DEFAULT_NETWORK_STATIONS = Object.freeze([
  {
    id: "earth-from-space",
    title: "Earth From Space",
    source: "NASA",
    categoryId: "space-observatories",
    category: "Space & Observatories",
    badge: "LIVE",
    schedule: "24/7",
    videoId: "awQzjn72bI0",
    thumbnail: "",
    description: "Live views of Earth from orbit.",
    attribution: "External public stream supplied by its source provider.",
    fallbackVideoId: "",
    enabled: true,
    rightsStatus: "APPROVED_EMBED",
    healthStatus: "ONLINE",
  },
  {
    id: "monterey-bay-live",
    title: "Monterey Bay Live",
    source: "Monterey Bay Aquarium",
    categoryId: "ocean-nature",
    category: "Ocean & Nature",
    badge: "LIVE",
    schedule: "24/7",
    videoId: "fVa6-zCBR7A",
    thumbnail: "",
    description: "A live public view from Monterey Bay.",
    attribution: "External public stream supplied by its source provider.",
    fallbackVideoId: "",
    enabled: true,
    rightsStatus: "APPROVED_EMBED",
    healthStatus: "ONLINE",
  },
  {
    id: "moon-jelly-cam",
    title: "Moon Jelly Cam",
    source: "Monterey Bay Aquarium",
    categoryId: "ocean-nature",
    category: "Ocean & Nature",
    badge: "LIVE",
    schedule: "24/7",
    videoId: "IEGYa3FlY1s",
    thumbnail: "",
    description: "A live public moon-jelly viewing experience.",
    attribution: "External public stream supplied by its source provider.",
    fallbackVideoId: "",
    enabled: true,
    rightsStatus: "APPROVED_EMBED",
    healthStatus: "ONLINE",
  },
]);

const subscriptionPersistenceStatus = {
  ready: isSubscriptionPersistenceReady(),
  hydrated: false,
  source: "LOCAL_JSON",
  lastReadAt: "",
  lastWriteAt: "",
  lastError: "",
};

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

function cleanNetworkStationId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeNetworkStation(station = {}, index = 0) {
  const title = cleanText(
    station.title || `AGV Network Station ${index + 1}`
  );

  const id =
    cleanNetworkStationId(station.id || title) ||
    `agv-network-station-${index + 1}`;

  return {
    id,
    title,
    source: cleanText(station.source || station.provider || ""),
    provider: cleanText(station.provider || station.source || ""),
    sourceType: cleanText(
      station.sourceType ||
      (station.videoId ? "YOUTUBE" : "DIRECT_MP4")
    ).toUpperCase(),
    sourceUrl: cleanText(station.sourceUrl || ""),
    embedUrl: cleanText(station.embedUrl || ""),
    fallbackUrl: cleanText(station.fallbackUrl || ""),
    categoryId:
      cleanNetworkStationId(station.categoryId || "uncategorized") ||
      "uncategorized",
    category: cleanText(station.category || "Uncategorized"),
    badge: cleanText(station.badge || "LIVE"),
    schedule: cleanText(station.schedule || "24/7"),
    videoId: cleanText(station.videoId || ""),
    thumbnail: cleanText(station.thumbnail || ""),
    description: cleanText(station.description || ""),
    attribution: cleanText(station.attribution || ""),
    fallbackVideoId: cleanText(station.fallbackVideoId || ""),
    enabled: station.enabled !== false,
    rightsStatus: cleanText(
      station.rightsStatus || "PENDING_REVIEW"
    ),
    healthStatus: cleanText(
      station.healthStatus || "UNKNOWN"
    ),
  };
}

function normalizeNetworkStations(value) {
  const source =
    Array.isArray(value) && value.length
      ? value
      : DEFAULT_NETWORK_STATIONS;

  const seen = new Set();

  return source
    .map(normalizeNetworkStation)
    .filter((station) => {
      const sourceType = String(station.sourceType || "").toUpperCase();
      const hasPlayableSource =
        (sourceType === "YOUTUBE" && Boolean(station.videoId)) ||
        ((sourceType === "DIRECT_MP4" ||
          sourceType === "DIRECT_WEBM") &&
          Boolean(station.sourceUrl)) ||
        (sourceType === "IFRAME" && Boolean(station.embedUrl || station.sourceUrl)) ||
        (sourceType === "HLS" && Boolean(station.sourceUrl)) ||
        (sourceType === "DASH" && Boolean(station.sourceUrl));

      if (
        !station.id ||
        !station.title ||
        !hasPlayableSource ||
        seen.has(station.id)
      ) {
        return false;
      }

      seen.add(station.id);
      return true;
    });
}

function defaultData() {
  const createdAt = nowIso();

  return {
    organizationId: "agv-demo",
    plan: "FREE",
    updatedAt: createdAt,
    account: defaultAccount(createdAt, "FREE"),
    accounts: {},
    networkStations: normalizeNetworkStations(
      DEFAULT_NETWORK_STATIONS
    ),
  };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");

  if (!isSubscriptionPersistenceReady()) {
    return;
  }

  saveSubscriptionState(data)
    .then((result) => {
      if (result?.ok) {
        subscriptionPersistenceStatus.ready = true;
        subscriptionPersistenceStatus.lastWriteAt =
          result.updatedAt || new Date().toISOString();
        subscriptionPersistenceStatus.lastError = "";
      } else {
        subscriptionPersistenceStatus.lastError =
          result?.error || result?.reason || "Supabase mirror failed.";
      }
    })
    .catch((error) => {
      subscriptionPersistenceStatus.lastError =
        error?.message || "Supabase mirror failed.";
    });
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
    passwordHash: account.passwordHash || account.password_hash || fallback.passwordHash || "",
    passwordChangedAt: account.passwordChangedAt || account.password_changed_at || fallback.passwordChangedAt || "",
    passwordResetHash: account.passwordResetHash || account.password_reset_hash || "",
    passwordResetExpiresAt: account.passwordResetExpiresAt || account.password_reset_expires_at || "",
    passwordResetCreatedAt: account.passwordResetCreatedAt || account.password_reset_created_at || "",
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

  migrated.networkStations = normalizeNetworkStations(
    migrated.networkStations
  );

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
  // PASS_110_H2A_ACCOUNT_PLAN_LOCK
  // Existing accounts retain their server-owned plan. New public accounts always start FREE.
  const savedAccount =
    cleanEmail && data.accounts?.[cleanEmail]
      ? data.accounts[cleanEmail]
      : data.account?.email === cleanEmail
        ? data.account
        : null;
  const cleanPlan = savedAccount?.plan
    ? normalizePlan(savedAccount.plan)
    : "FREE";
  const timestamp = nowIso();

  const existingAccount = savedAccount || {};

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

  // PASS_110_H2A_PRIMARY_ACCOUNT_LOCK
  // Public account creation must not replace Byron's primary AGV account or shared plan.
  const isPrimaryAccount =
    !data.account?.email || normalizeEmail(data.account.email) === cleanEmail;

  if (isPrimaryAccount) {
    data.organizationId = nextAccount.accountId || data.organizationId || "agv-demo";
    data.plan = cleanPlan;
    data.account = nextAccount;
  }

  data.updatedAt = timestamp;

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
    persistence: {
      ready: subscriptionPersistenceStatus.ready,
      hydrated: subscriptionPersistenceStatus.hydrated,
      source: subscriptionPersistenceStatus.source,
      lastReadAt: subscriptionPersistenceStatus.lastReadAt,
      lastWriteAt: subscriptionPersistenceStatus.lastWriteAt,
      lastError: subscriptionPersistenceStatus.lastError,
    },
  });
});

function getAgvBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  ).trim();

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return authorization.slice(7).trim();
}

function requireNetworkSuperAdmin(req, res, next) {
  if (!AGV_SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "Verified AGV session authentication is not configured.",
    });
  }

  if (!AGV_SUPER_ADMIN_EMAILS.size) {
    return res.status(503).json({
      ok: false,
      error: "AGV Super Admin email authorization is not configured.",
    });
  }

  const token = getAgvBearerToken(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "A verified AGV session token is required.",
    });
  }

  try {
    const claims = agvHostSessionJwt.verify(
      token,
      AGV_SESSION_SECRET,
      {
        issuer: "agv-subscription-server",
        audience: "agv-platform",
      }
    );

    const email = normalizeEmail(claims?.email || "");

    if (
      claims?.tokenType !== "agv_host_session" ||
      !email ||
      !AGV_SUPER_ADMIN_EMAILS.has(email)
    ) {
      return res.status(403).json({
        ok: false,
        error: "AGV Super Admin authorization is required.",
      });
    }

    req.agvNetworkAdmin = {
      sub: claims.sub,
      email,
    };

    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "The AGV session token is invalid or expired.",
    });
  }
}

app.get("/api/network/stations", (req, res) => {
  const data = readData();
  const stations = normalizeNetworkStations(
    data.networkStations
  ).filter((station) => station.enabled !== false);

  return res.json({
    ok: true,
    stations,
    count: stations.length,
    updatedAt:
      data.networkStationsUpdatedAt ||
      data.updatedAt ||
      "",
  });
});

app.get(
  "/api/network/stations/admin",
  requireNetworkSuperAdmin,
  (req, res) => {
    const data = readData();
    const stations = normalizeNetworkStations(
      data.networkStations
    );

    return res.json({
      ok: true,
      stations,
      count: stations.length,
      updatedAt:
        data.networkStationsUpdatedAt ||
        data.updatedAt ||
        "",
    });
  }
);

app.put(
  "/api/network/stations",
  requireNetworkSuperAdmin,
  (req, res) => {
    if (!Array.isArray(req.body?.stations)) {
      return res.status(400).json({
        ok: false,
        error: "A stations array is required.",
      });
    }

    const stations = normalizeNetworkStations(
      req.body.stations
    );

    if (!stations.length) {
      return res.status(400).json({
        ok: false,
        error: "At least one valid AGV Network station is required.",
      });
    }

    const data = readData();
    const timestamp = nowIso();

    data.networkStations = stations;
    data.networkStationsUpdatedAt = timestamp;
    data.networkStationsUpdatedBy =
      req.agvNetworkAdmin.email;
    data.updatedAt = timestamp;

    writeData(data);

    return res.json({
      ok: true,
      stations,
      count: stations.length,
      updatedAt: timestamp,
      updatedBy: req.agvNetworkAdmin.email,
      message: "AGV Network station registry saved.",
    });
  }
);

app.get("/api/subscription", (req, res) => {
  res.json(getSubscriptionPayload());
});

app.post("/api/subscription/plan", (req, res) => {
  // PASS_110_H2A_LOCAL_ONLY_PLAN_CHANGE
  // Temporary containment: only the AGV workstation may change subscription plans.
  const remoteAddress = String(req.socket?.remoteAddress || req.ip || "");
  const isLocalRequest =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";

  if (!isLocalRequest) {
    return res.status(403).json({
      ok: false,
      error: "Subscription plan changes are restricted to the AGV workstation.",
    });
  }

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


// PASS_HOST_PASSWORD_RECOVERY_8792_1A
// SERVER 8792 - Host account password foundation and recovery.
// Passwords and reset codes are hashed. Old passwords are never revealed.
const agvHostPasswordBcrypt = require("bcryptjs");
const agvHostPasswordCrypto = require("crypto");
const agvHostSessionJwt = require("jsonwebtoken");
const AGV_SESSION_SECRET = String(process.env.AGV_SESSION_SECRET || "").trim();
const AGV_SESSION_TTL = "2h";
const agvHostLoginAttempts = new Map();
function getAgvHostPasswordAccount(email) {
  const cleanEmail = normalizeEmail(email);
  const data = readData();
  if (!cleanEmail) {
    return { data, account: null, email: "" };
  }
  if (!data.accounts || typeof data.accounts !== "object") {
    data.accounts = {};
  }
  let account = data.accounts[cleanEmail] || null;
  if (!account && data.account?.email === cleanEmail) {
    account = data.account;
  }
  if (!account) {
    return { data, account: null, email: cleanEmail };
  }
  account = migrateAccount(account, {
    organizationId: data.organizationId,
    plan: data.plan,
    updatedAt: data.updatedAt,
  });
  data.accounts[cleanEmail] = account;
  if (data.account?.email === cleanEmail) {
    data.account = {
      ...data.account,
      ...account,
    };
  }
  return { data, account, email: cleanEmail };
}
function saveAgvHostPasswordAccount(data, account) {
  const cleanEmail = normalizeEmail(account?.email);
  if (!cleanEmail) {
    return null;
  }
  const timestamp = nowIso();
  if (!data.accounts || typeof data.accounts !== "object") {
    data.accounts = {};
  }
  account.email = cleanEmail;
  account.updatedAt = timestamp;
  data.updatedAt = timestamp;
  data.accounts[cleanEmail] = account;
  if (!data.account?.email || data.account.email === cleanEmail) {
    data.account = {
      ...data.account,
      ...account,
    };
    data.plan = normalizePlan(account.plan || data.plan);
  }
  writeData(data);
  return account;
}
// CONTROL_LIST_1A2_VERIFIED_HOST_LOGIN
app.post("/api/account/login", (req, res) => {
  if (!AGV_SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "Verified AGV account login is not configured.",
    });
  }
  const email = normalizeEmail(req.body.email || req.body.ownerEmail || "");
  const password = String(req.body.password || "");
  const attemptKey = email || String(req.ip || "unknown");
  const now = Date.now();
  const previousAttempt = agvHostLoginAttempts.get(attemptKey) || {
    count: 0,
    windowStartedAt: now,
  };
  const activeAttempt =
    now - previousAttempt.windowStartedAt > 15 * 60 * 1000
      ? { count: 0, windowStartedAt: now }
      : previousAttempt;
  if (activeAttempt.count >= 5) {
    return res.status(429).json({
      ok: false,
      error: "Too many failed login attempts. Try again later.",
    });
  }
  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Email and password are required.",
    });
  }
  const holder = getAgvHostPasswordAccount(email);
  const account = holder.account;
  const passwordOk = Boolean(
    account?.passwordHash &&
      agvHostPasswordBcrypt.compareSync(password, account.passwordHash)
  );
  if (!passwordOk) {
    activeAttempt.count += 1;
    agvHostLoginAttempts.set(attemptKey, activeAttempt);
    return res.status(401).json({
      ok: false,
      error: "Invalid email or password.",
    });
  }
  agvHostLoginAttempts.delete(attemptKey);
  account.lastLoginAt = nowIso();
  saveAgvHostPasswordAccount(holder.data, account);
  const token = agvHostSessionJwt.sign(
    {
      sub: account.accountId || account.id || account.email,
      email: account.email,
      role: account.role || "owner",
      plan: normalizePlan(account.plan || "FREE"),
      tokenType: "agv_host_session",
    },
    AGV_SESSION_SECRET,
    {
      expiresIn: AGV_SESSION_TTL,
      issuer: "agv-subscription-server",
      audience: "agv-platform",
    }
  );
  return res.json({
    ok: true,
    token,
    tokenType: "Bearer",
    expiresIn: AGV_SESSION_TTL,
    account: publicAccountPayload(account, account.plan),
    message: "AGV host identity verified.",
  });
});

app.post("/api/account/set-password", (req, res) => {
  const email = normalizeEmail(req.body.email || req.body.ownerEmail || req.body.accountEmail || "");
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");
  if (!email || !newPassword) {
    return res.status(400).json({
      ok: false,
      error: "Email and new password are required.",
    });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "New password must be at least 8 characters.",
    });
  }
  let holder = getAgvHostPasswordAccount(email);
  let account = holder.account;
  let data = holder.data;
  if (!account) {
    upsertAccount({
      email,
      name: req.body.name || "",
      organization: req.body.organization || "",
      role: req.body.role || "owner",
      plan: req.body.plan || "FREE",
      markLogin: false,
    });
    holder = getAgvHostPasswordAccount(email);
    account = holder.account;
    data = holder.data;
  }
  if (!account) {
    return res.status(404).json({
      ok: false,
      error: "Account could not be created or found.",
    });
  }
  if (account.passwordHash) {
    if (!currentPassword) {
      return res.status(401).json({
        ok: false,
        error: "Current password is required to change this host password.",
      });
    }
    const currentPasswordOk = agvHostPasswordBcrypt.compareSync(currentPassword, account.passwordHash);
    if (!currentPasswordOk) {
      return res.status(401).json({
        ok: false,
        error: "Current password is incorrect.",
      });
    }
  }
  account.passwordHash = agvHostPasswordBcrypt.hashSync(newPassword, 10);
  account.passwordChangedAt = nowIso();
  delete account.passwordResetHash;
  delete account.passwordResetExpiresAt;
  delete account.passwordResetCreatedAt;
  saveAgvHostPasswordAccount(data, account);
  return res.json({
    ok: true,
    message: "Host password saved.",
    account: publicAccountPayload(account, account.plan),
  });
});
app.post("/api/account/password-reset/request", (req, res) => {
  const email = normalizeEmail(req.body.email || req.body.ownerEmail || req.body.accountEmail || "");
  if (!email) {
    return res.status(400).json({
      ok: false,
      error: "Email is required.",
    });
  }
  const holder = getAgvHostPasswordAccount(email);
  const account = holder.account;
  if (!account) {
    return res.json({
      ok: true,
      message: "If the host account exists, a reset code has been created.",
    });
  }
  const resetCode = String(agvHostPasswordCrypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 15 * 60 * 1000;
  account.passwordResetHash = agvHostPasswordBcrypt.hashSync(resetCode, 10);
  account.passwordResetExpiresAt = new Date(expiresAt).toISOString();
  account.passwordResetCreatedAt = nowIso();
  saveAgvHostPasswordAccount(holder.data, account);
  console.log("");
  console.log("AGV HOST PASSWORD RESET CODE - SERVER 8792");
  console.log("Email:", account.email);
  console.log("Name:", account.name || "AGV Host");
  console.log("Reset Code:", resetCode);
  console.log("Expires:", account.passwordResetExpiresAt);
  console.log("");
  return res.json({
    ok: true,
    message: "If the host account exists, a reset code has been created. Check the SERVER 8792 console.",
    resetCodeDelivery: "SERVER_8792_CONSOLE_LOCAL_TEST",
  });
});
app.post("/api/account/password-reset/confirm", (req, res) => {
  const email = normalizeEmail(req.body.email || req.body.ownerEmail || req.body.accountEmail || "");
  const resetCode = String(req.body.resetCode || "").trim();
  const newPassword = String(req.body.newPassword || "");
  if (!email || !resetCode || !newPassword) {
    return res.status(400).json({
      ok: false,
      error: "Email, reset code, and new password are required.",
    });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "New password must be at least 8 characters.",
    });
  }
  const holder = getAgvHostPasswordAccount(email);
  const account = holder.account;
  if (!account || !account.passwordResetHash || !account.passwordResetExpiresAt) {
    return res.status(400).json({
      ok: false,
      error: "Invalid or expired reset code.",
    });
  }
  if (Date.now() > new Date(account.passwordResetExpiresAt).getTime()) {
    delete account.passwordResetHash;
    delete account.passwordResetExpiresAt;
    delete account.passwordResetCreatedAt;
    saveAgvHostPasswordAccount(holder.data, account);
    return res.status(400).json({
      ok: false,
      error: "Reset code expired.",
    });
  }
  const resetCodeOk = agvHostPasswordBcrypt.compareSync(resetCode, account.passwordResetHash);
  if (!resetCodeOk) {
    return res.status(400).json({
      ok: false,
      error: "Invalid or expired reset code.",
    });
  }
  account.passwordHash = agvHostPasswordBcrypt.hashSync(newPassword, 10);
  account.passwordChangedAt = nowIso();
  delete account.passwordResetHash;
  delete account.passwordResetExpiresAt;
  delete account.passwordResetCreatedAt;
  saveAgvHostPasswordAccount(holder.data, account);
  return res.json({
    ok: true,
    message: "Password reset successful. The host may now use the new password.",
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

async function hydrateSubscriptionState() {
  if (!isSubscriptionPersistenceReady()) {
    subscriptionPersistenceStatus.ready = false;
    subscriptionPersistenceStatus.source = "LOCAL_JSON";
    return;
  }

  subscriptionPersistenceStatus.ready = true;
  const result = await loadSubscriptionState();

  if (result?.ok && result?.found && result?.payload) {
    const hydratedData = migrateData(result.payload);
    fs.writeFileSync(DATA_FILE, JSON.stringify(hydratedData, null, 2), "utf8");
    subscriptionPersistenceStatus.hydrated = true;
    subscriptionPersistenceStatus.source = "SUPABASE";
    subscriptionPersistenceStatus.lastReadAt =
      result.updatedAt || new Date().toISOString();
    subscriptionPersistenceStatus.lastError = "";
    return;
  }

  if (result?.ok && !result?.found) {
    const localData = readData();
    const seedResult = await saveSubscriptionState(localData);
    subscriptionPersistenceStatus.source = "LOCAL_JSON_SEEDED";
    subscriptionPersistenceStatus.lastWriteAt = seedResult?.updatedAt || "";
    subscriptionPersistenceStatus.lastError = seedResult?.ok
      ? ""
      : seedResult?.error || seedResult?.reason || "Supabase seed failed.";
    return;
  }

  subscriptionPersistenceStatus.source = "LOCAL_JSON_FALLBACK";
  subscriptionPersistenceStatus.lastError =
    result?.error || result?.reason || "Supabase hydration failed.";
}

async function startSubscriptionServer() {
  try {
    await hydrateSubscriptionState();
  } catch (error) {
    subscriptionPersistenceStatus.source = "LOCAL_JSON_FALLBACK";
    subscriptionPersistenceStatus.lastError =
      error?.message || "Supabase startup hydration failed.";
  }

  app.listen(PORT, () => {
    console.log("AGV SUBSCRIPTION + ACCOUNT SERVER RUNNING ON", PORT);
    console.log("SUBSCRIPTION DATA FILE:", DATA_FILE);
    console.log("SUBSCRIPTION PERSISTENCE:", subscriptionPersistenceStatus.source);
    console.log("ACCOUNT FOUNDATION: ENABLED");
    console.log("PLAN ENFORCEMENT FOUNDATION: ENABLED");
    console.log("STRIPE CUSTOMER FIELD FOUNDATION: ENABLED");
  });
}

startSubscriptionServer();
