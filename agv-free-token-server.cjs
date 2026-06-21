require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.FREE_TOKEN_PORT || process.env.PORT || 8794);
const DATA_FILE = path.join(__dirname, "agv-free-token-wallets.json");

const STARTING_FREE_TOKENS = 150000;

const BURN_MODEL = {
  hostTokensPerMinute: 60,
  viewerTokensPerViewerPerMinute: 6,
  screenShareMultiplier: 2,
};

const PLAN_DEFAULTS = {
  FREE: {
    monthlyLiveTokens: 150000,
    monthlyBroadcastCredits: 0,
  },
  CREATOR: {
    monthlyLiveTokens: 500000,
    monthlyBroadcastCredits: 10000,
  },
  MINISTRY: {
    monthlyLiveTokens: 2500000,
    monthlyBroadcastCredits: 75000,
  },
  PRO: {
    monthlyLiveTokens: 2500000,
    monthlyBroadcastCredits: 75000,
  },
  CONVENTION: {
    monthlyLiveTokens: 10000000,
    monthlyBroadcastCredits: 300000,
  },
};

const BROADCAST_CREDIT_PACKS = [
  { id: "starter", name: "Starter Broadcast Pack", credits: 25000, priceUsd: 59 },
  { id: "growth", name: "Growth Broadcast Pack", credits: 100000, priceUsd: 199 },
  { id: "event", name: "Event Broadcast Pack", credits: 500000, priceUsd: 799 },
  { id: "convention", name: "Convention Broadcast Pack", credits: 1500000, priceUsd: 1999 },
];

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  } catch (err) {
    console.warn("Stripe package could not be loaded:", err.message);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePlan(plan) {
  const p = String(plan || "FREE").trim().toUpperCase();
  if (p === "MINISTRY" || p === "PRO") return p;
  if (p === "CREATOR" || p === "CONVENTION" || p === "FREE") return p;
  return "FREE";
}

function normalizeUserId(userId) {
  return String(userId || "local-free-user").trim() || "local-free-user";
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {
        wallets: {},
        sessions: {},
        broadcastPackCheckoutSessions: {},
        broadcastPackTransactions: {},
      };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    return {
      ...parsed,
      wallets: parsed.wallets && typeof parsed.wallets === "object" ? parsed.wallets : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      broadcastPackCheckoutSessions:
        parsed.broadcastPackCheckoutSessions && typeof parsed.broadcastPackCheckoutSessions === "object"
          ? parsed.broadcastPackCheckoutSessions
          : {},
      broadcastPackTransactions:
        parsed.broadcastPackTransactions && typeof parsed.broadcastPackTransactions === "object"
          ? parsed.broadcastPackTransactions
          : {},
    };
  } catch (err) {
    console.error("loadDb failed:", err.message);
    return {
      wallets: {},
      sessions: {},
      broadcastPackCheckoutSessions: {},
      broadcastPackTransactions: {},
    };
  }
}

function saveDb(db) {
  const clean = {
    ...db,
    wallets: db.wallets || {},
    sessions: db.sessions || {},
    broadcastPackCheckoutSessions: db.broadcastPackCheckoutSessions || {},
    broadcastPackTransactions: db.broadcastPackTransactions || {},
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2), "utf8");
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(data));
}

function readBodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      const buffer = Buffer.concat(chunks);

      if (!buffer.length) {
        resolve("");
        return;
      }

      let text = buffer.toString("utf8");

      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }

      resolve(text.trim());
    });

    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const text = await readBodyText(req);

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (err) {
    return {
      __parseError: err.message,
      __rawBody: text,
    };
  }
}

function getBroadcastCreditPackById(packId) {
  const id = String(packId || "").trim().toLowerCase();
  return BROADCAST_CREDIT_PACKS.find((pack) => pack.id === id) || null;
}

function getPlanDefaults(plan) {
  return PLAN_DEFAULTS[normalizePlan(plan)] || PLAN_DEFAULTS.FREE;
}

function ensureWallet(db, userId, plan) {
  const id = normalizeUserId(userId);
  const normalizedPlan = normalizePlan(plan);
  const defaults = getPlanDefaults(normalizedPlan);

  if (!db.wallets[id]) {
    db.wallets[id] = {
      userId: id,
      plan: normalizedPlan,
      startingBalance: normalizedPlan === "FREE" ? STARTING_FREE_TOKENS : null,
      balance: normalizedPlan === "FREE" ? STARTING_FREE_TOKENS : null,
      lifetimeDebited: 0,
      status: "active",
      createdAt: nowIso(),
      monthlyLiveTokens: defaults.monthlyLiveTokens,
      liveTokensBalance: defaults.monthlyLiveTokens,
      monthlyBroadcastCredits: defaults.monthlyBroadcastCredits,
      broadcastCreditsBalance: defaults.monthlyBroadcastCredits,
      purchasedBroadcastCredits: 0,
      lifetimeBroadcastCreditsUsed: 0,
      updatedAt: nowIso(),
    };
  }

  const wallet = db.wallets[id];

  const previousMonthlyLiveTokens = Number(wallet.monthlyLiveTokens || 0);
  const previousMonthlyBroadcastCredits = Number(wallet.monthlyBroadcastCredits || 0);

  wallet.plan = normalizedPlan;

  // PASS_SERVER_8794_WALLET_PLAN_DEFAULT_FIX_1A
  // If an older wallet was created as FREE, then later upgraded to CREATOR / MINISTRY / PRO / CONVENTION,
  // bring its monthly allowance fields up to the current plan defaults without wiping purchased credits.
  wallet.monthlyLiveTokens = Number(wallet.monthlyLiveTokens ?? defaults.monthlyLiveTokens);
  if (wallet.monthlyLiveTokens < defaults.monthlyLiveTokens) {
    wallet.monthlyLiveTokens = defaults.monthlyLiveTokens;

    if (Number(wallet.liveTokensBalance || 0) <= previousMonthlyLiveTokens) {
      wallet.liveTokensBalance = defaults.monthlyLiveTokens;
    }
  }

  wallet.liveTokensBalance = Number(wallet.liveTokensBalance ?? defaults.monthlyLiveTokens);

  wallet.monthlyBroadcastCredits = Number(wallet.monthlyBroadcastCredits ?? defaults.monthlyBroadcastCredits);
  if (wallet.monthlyBroadcastCredits < defaults.monthlyBroadcastCredits) {
    wallet.monthlyBroadcastCredits = defaults.monthlyBroadcastCredits;

    if (Number(wallet.broadcastCreditsBalance || 0) <= previousMonthlyBroadcastCredits) {
      wallet.broadcastCreditsBalance = defaults.monthlyBroadcastCredits;
    }
  }

  wallet.broadcastCreditsBalance = Number(wallet.broadcastCreditsBalance ?? defaults.monthlyBroadcastCredits);
  wallet.purchasedBroadcastCredits = Number(wallet.purchasedBroadcastCredits || 0);
  wallet.lifetimeBroadcastCreditsUsed = Number(wallet.lifetimeBroadcastCreditsUsed || 0);
  wallet.updatedAt = nowIso();

  return wallet;
}

function estimateBroadcastCredits(body) {
  const expectedViewers = Math.max(0, Number(body.expectedViewers || body.viewers || 0));
  const minutes = Math.max(1, Number(body.minutes || body.eventMinutes || 60));
  const interactivePeople = Math.max(0, Number(body.interactivePeople || 1));
  const screenShare = Boolean(body.screenShare || body.screenShareOn);

  const baseHost = BURN_MODEL.hostTokensPerMinute * minutes * Math.max(1, interactivePeople);
  const viewerCost = BURN_MODEL.viewerTokensPerViewerPerMinute * expectedViewers * minutes;
  const multiplier = screenShare ? BURN_MODEL.screenShareMultiplier : 1;
  const requiredBroadcastCredits = Math.ceil((baseHost + viewerCost) * multiplier);

  return {
    expectedViewers,
    minutes,
    interactivePeople,
    screenShare,
    requiredBroadcastCredits,
    burnModel: BURN_MODEL,
  };
}

function recommendPack(shortage) {
  const needed = Math.max(0, Number(shortage || 0));
  return BROADCAST_CREDIT_PACKS.find((pack) => pack.credits >= needed) || BROADCAST_CREDIT_PACKS[BROADCAST_CREDIT_PACKS.length - 1];
}

function addBroadcastPackToWallet(wallet, pack) {
  wallet.broadcastCreditsBalance = Number(wallet.broadcastCreditsBalance || 0) + Number(pack.credits);
  wallet.purchasedBroadcastCredits = Number(wallet.purchasedBroadcastCredits || 0) + Number(pack.credits);
  wallet.updatedAt = nowIso();
  return wallet;
}

function getBaseUrl() {
  return (
    process.env.AGV_APP_BASE_URL ||
    process.env.CLIENT_URL ||
    "http://127.0.0.1:5175"
  ).replace(/\/$/, "");
}

function getPathname(req) {
  return new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).pathname;
}

function getQuery(req) {
  return new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).searchParams;
}

async function handleRequest(req, res) {
  const pathname = getPathname(req);
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (method === "GET" && pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "AGV Usage Wallet Server",
      usageWalletModel: true,
      liveTokensEnabled: true,
      broadcastCreditsEnabled: true,
      broadcastCreditPacks: BROADCAST_CREDIT_PACKS,
      port: PORT,
      startingFreeTokens: STARTING_FREE_TOKENS,
      dataFile: DATA_FILE,
      burnModel: BURN_MODEL,
      stripeConfigured: Boolean(stripe),
      stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    });
  }

  if (method === "GET" && pathname === "/api/usage/wallet") {
    const db = loadDb();
    const query = getQuery(req);
    const userId = normalizeUserId(query.get("userId"));
    const plan = normalizePlan(query.get("plan"));
    const wallet = ensureWallet(db, userId, plan);
    saveDb(db);
    return sendJson(res, 200, { ok: true, wallet });
  }

  if (method === "POST" && pathname === "/api/usage/estimate-event") {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body.", detail: body.__parseError, raw: body.__rawBody });
    }

    const db = loadDb();
    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const wallet = ensureWallet(db, userId, plan);
    const estimate = estimateBroadcastCredits(body);
    const availableBroadcastCredits = Number(wallet.broadcastCreditsBalance || 0);
    const shortage = Math.max(0, estimate.requiredBroadcastCredits - availableBroadcastCredits);
    const allowed = shortage <= 0;
    const recommendedPack = allowed ? null : recommendPack(shortage);

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      allowed,
      userId,
      plan,
      wallet,
      estimate,
      availableBroadcastCredits,
      shortage,
      recommendedPack,
    });
  }

  if (method === "POST" && pathname === "/api/usage/start-broadcast-gate") {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body.", detail: body.__parseError, raw: body.__rawBody });
    }

    const db = loadDb();
    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const wallet = ensureWallet(db, userId, plan);
    const estimate = estimateBroadcastCredits(body);
    const availableBroadcastCredits = Number(wallet.broadcastCreditsBalance || 0);
    const shortage = Math.max(0, estimate.requiredBroadcastCredits - availableBroadcastCredits);
    const allowed = shortage <= 0;
    const recommendedPack = allowed ? null : recommendPack(shortage);

    if (allowed) {
      wallet.broadcastCreditsBalance = availableBroadcastCredits - estimate.requiredBroadcastCredits;
      wallet.lifetimeBroadcastCreditsUsed = Number(wallet.lifetimeBroadcastCreditsUsed || 0) + estimate.requiredBroadcastCredits;
      wallet.updatedAt = nowIso();
      saveDb(db);
    } else {
      saveDb(db);
    }

    return sendJson(res, allowed ? 200 : 402, {
      ok: allowed,
      allowed,
      reason: allowed ? "BROADCAST_CREDITS_APPROVED" : "BROADCAST_CREDITS_REQUIRED",
      wallet,
      estimate,
      availableBroadcastCredits,
      shortage,
      recommendedPack,
    });
  }

  if (method === "POST" && pathname === "/api/usage/add-broadcast-pack") {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body.", detail: body.__parseError, raw: body.__rawBody });
    }

    const db = loadDb();
    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const packId = String(body.packId || "").trim().toLowerCase();
    const pack = getBroadcastCreditPackById(packId);
    const wallet = ensureWallet(db, userId, plan);

    if (!pack) {
      return sendJson(res, 400, { ok: false, error: "Unknown Broadcast Credit Pack.", packId, availablePacks: BROADCAST_CREDIT_PACKS, wallet });
    }

    if (plan === "FREE") {
      return sendJson(res, 403, { ok: false, error: "Free plan cannot add Cloudflare Broadcast Credits.", wallet });
    }

    addBroadcastPackToWallet(wallet, pack);

    const transactionId = "local-bpack-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    db.broadcastPackTransactions[transactionId] = {
      transactionId,
      source: "local-dev",
      userId,
      plan,
      packId: pack.id,
      credits: pack.credits,
      priceUsd: pack.priceUsd,
      createdAt: nowIso(),
    };

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      localDevCredit: true,
      transactionId,
      pack,
      wallet,
    });
  }

  if (method === "POST" && pathname === "/api/usage/create-broadcast-pack-checkout") {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body.", detail: body.__parseError, raw: body.__rawBody });
    }

    const db = loadDb();
    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const packId = String(body.packId || "").trim().toLowerCase();
    const pack = getBroadcastCreditPackById(packId);
    const wallet = ensureWallet(db, userId, plan);

    if (!pack) {
      saveDb(db);
      return sendJson(res, 400, {
        ok: false,
        error: "Unknown Broadcast Credit Pack.",
        receivedBody: body,
        packId,
        availablePacks: BROADCAST_CREDIT_PACKS,
        wallet,
      });
    }

    if (plan === "FREE") {
      saveDb(db);
      return sendJson(res, 403, {
        ok: false,
        error: "Free plan cannot purchase Cloudflare Broadcast Credits.",
        wallet,
      });
    }

    if (!stripe) {
      saveDb(db);
      return sendJson(res, 500, {
        ok: false,
        error: "Stripe is not configured on SERVER 8794.",
        wallet,
      });
    }

    const checkoutId = "bpack-checkout-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    const baseUrl = getBaseUrl();

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: Number(pack.priceUsd) * 100,
              product_data: {
                name: `AGV ${pack.name}`,
                description: `${pack.credits.toLocaleString()} AGV Cloudflare Broadcast Credits`,
                metadata: {
                  checkoutId,
                  packId: pack.id,
                  userId,
                  plan,
                },
              },
            },
          },
        ],
        success_url: `${baseUrl}?agvBroadcastPack=success&packId=${encodeURIComponent(pack.id)}&checkoutId=${encodeURIComponent(checkoutId)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}?agvBroadcastPack=cancel&packId=${encodeURIComponent(pack.id)}&checkoutId=${encodeURIComponent(checkoutId)}`,
        metadata: {
          checkoutId,
          userId,
          plan,
          packId: pack.id,
          credits: String(pack.credits),
          priceUsd: String(pack.priceUsd),
        },
      });

      db.broadcastPackCheckoutSessions[checkoutId] = {
        checkoutId,
        stripeSessionId: session.id,
        userId,
        plan,
        packId: pack.id,
        credits: pack.credits,
        priceUsd: pack.priceUsd,
        status: "created",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      saveDb(db);

      return sendJson(res, 200, {
        ok: true,
        stripeCheckout: true,
        checkoutId,
        stripeSessionId: session.id,
        checkoutUrl: session.url,
        pack,
        wallet,
      });
    } catch (err) {
      saveDb(db);
      return sendJson(res, 500, {
        ok: false,
        error: "Stripe Checkout creation failed.",
        detail: err.message,
        pack,
        wallet,
      });
    }
  }


  // PASS_SERVER_8794_STRIPE_WEBHOOK_1A
  // SERVER 8794 — Real Stripe webhook for Broadcast Pack crediting.
  if (method === "POST" && pathname === "/api/usage/stripe-webhook") {
    if (!stripe) {
      return sendJson(res, 500, {
        ok: false,
        error: "Stripe is not configured on SERVER 8794.",
      });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return sendJson(res, 500, {
        ok: false,
        error: "STRIPE_WEBHOOK_SECRET is not configured on SERVER 8794.",
      });
    }

    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return sendJson(res, 400, {
        ok: false,
        error: "Missing Stripe signature header.",
      });
    }

    let event;
    let rawBody;

    try {
      rawBody = await readBodyText(req);
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err) {
      return sendJson(res, 400, {
        ok: false,
        error: "Stripe webhook signature verification failed.",
        detail: err.message,
      });
    }

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return sendJson(res, 200, {
        ok: true,
        ignored: true,
        eventType: event.type,
      });
    }

    const session = event.data && event.data.object ? event.data.object : null;

    if (!session || !session.id) {
      return sendJson(res, 400, {
        ok: false,
        error: "Stripe webhook did not include a checkout session.",
        eventType: event.type,
      });
    }

    const paymentStatus = String(session.payment_status || "").toLowerCase();

    if (paymentStatus !== "paid") {
      return sendJson(res, 200, {
        ok: true,
        paid: false,
        ignored: true,
        reason: "STRIPE_PAYMENT_NOT_PAID",
        stripePaymentStatus: session.payment_status,
        stripeSessionId: session.id,
      });
    }

    const db = loadDb();

    if (!db.broadcastPackCheckoutSessions || typeof db.broadcastPackCheckoutSessions !== "object") {
      db.broadcastPackCheckoutSessions = {};
    }

    if (!db.broadcastPackTransactions || typeof db.broadcastPackTransactions !== "object") {
      db.broadcastPackTransactions = {};
    }

    const metadata = session.metadata || {};
    const checkoutIdFromStripe = String(metadata.checkoutId || "").trim();
    const stripeSessionId = String(session.id || "").trim();

    let storedCheckout = checkoutIdFromStripe
      ? db.broadcastPackCheckoutSessions[checkoutIdFromStripe]
      : null;

    if (!storedCheckout) {
      storedCheckout = Object.values(db.broadcastPackCheckoutSessions).find(
        (entry) => entry && entry.stripeSessionId === stripeSessionId
      );
    }

    if (!storedCheckout && checkoutIdFromStripe) {
      storedCheckout = {
        checkoutId: checkoutIdFromStripe,
        stripeSessionId,
        userId: normalizeUserId(metadata.userId),
        plan: normalizePlan(metadata.plan),
        packId: String(metadata.packId || "").trim().toLowerCase(),
        credits: Number(metadata.credits || 0),
        priceUsd: Number(metadata.priceUsd || 0),
        status: "created_from_webhook",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      db.broadcastPackCheckoutSessions[checkoutIdFromStripe] = storedCheckout;
    }

    if (!storedCheckout) {
      return sendJson(res, 404, {
        ok: false,
        error: "Broadcast Pack checkout session was not found for paid Stripe webhook.",
        checkoutId: checkoutIdFromStripe,
        stripeSessionId,
      });
    }

    const existingTransaction = Object.values(db.broadcastPackTransactions).find(
      (tx) => tx && tx.stripeSessionId === stripeSessionId && tx.status === "credited"
    );

    if (existingTransaction) {
      return sendJson(res, 200, {
        ok: true,
        alreadyCredited: true,
        transactionId: existingTransaction.transactionId,
        checkoutId: storedCheckout.checkoutId,
        stripeSessionId,
      });
    }

    const pack = getBroadcastCreditPackById(storedCheckout.packId);

    if (!pack) {
      return sendJson(res, 500, {
        ok: false,
        error: "Stored checkout pack is no longer valid.",
        checkout: storedCheckout,
        stripeSessionId,
      });
    }

    const wallet = ensureWallet(db, storedCheckout.userId, storedCheckout.plan);
    addBroadcastPackToWallet(wallet, pack);

    const transactionId =
      "stripe-webhook-bpack-" + Date.now() + "-" + Math.random().toString(16).slice(2);

    db.broadcastPackTransactions[transactionId] = {
      transactionId,
      status: "credited",
      source: "stripe-webhook",
      eventId: event.id,
      eventType: event.type,
      checkoutId: storedCheckout.checkoutId,
      stripeSessionId,
      stripePaymentStatus: session.payment_status,
      userId: storedCheckout.userId,
      plan: storedCheckout.plan,
      packId: pack.id,
      credits: pack.credits,
      priceUsd: pack.priceUsd,
      createdAt: nowIso(),
    };

    storedCheckout.status = "credited";
    storedCheckout.paymentStatus = session.payment_status;
    storedCheckout.creditedTransactionId = transactionId;
    storedCheckout.updatedAt = nowIso();

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      paid: true,
      credited: true,
      transactionId,
      checkoutId: storedCheckout.checkoutId,
      stripeSessionId,
      wallet,
    });
  }

  if (method === "POST" && pathname === "/api/usage/confirm-broadcast-pack-checkout") {
    const body = await readJsonBody(req);
    if (body.__parseError) {
      return sendJson(res, 400, { ok: false, error: "Invalid JSON body.", detail: body.__parseError, raw: body.__rawBody });
    }

    const db = loadDb();
    const checkoutId = String(body.checkoutId || "").trim();
    const stripeSessionIdInput = String(body.stripeSessionId || "").trim();

    let storedCheckout = checkoutId ? db.broadcastPackCheckoutSessions[checkoutId] : null;

    if (!storedCheckout && stripeSessionIdInput) {
      storedCheckout = Object.values(db.broadcastPackCheckoutSessions).find(
        (entry) => entry && entry.stripeSessionId === stripeSessionIdInput
      );
    }

    if (!storedCheckout) {
      return sendJson(res, 404, {
        ok: false,
        error: "Broadcast Pack checkout session was not found.",
        checkoutId,
        stripeSessionId: stripeSessionIdInput,
        receivedBody: body,
      });
    }

    if (!stripe) {
      return sendJson(res, 500, {
        ok: false,
        error: "Stripe is not configured on SERVER 8794.",
        checkoutId: storedCheckout.checkoutId,
        stripeSessionId: storedCheckout.stripeSessionId,
      });
    }

    const existingTransaction = Object.values(db.broadcastPackTransactions).find(
      (tx) => tx && tx.stripeSessionId === storedCheckout.stripeSessionId && tx.status === "credited"
    );

    if (existingTransaction) {
      return sendJson(res, 200, {
        ok: true,
        alreadyCredited: true,
        transactionId: existingTransaction.transactionId,
        checkout: storedCheckout,
        wallet: db.wallets[storedCheckout.userId],
      });
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(storedCheckout.stripeSessionId);
    } catch (err) {
      return sendJson(res, 502, {
        ok: false,
        error: "Could not verify Stripe Checkout session.",
        detail: err.message,
        checkout: storedCheckout,
      });
    }

    if (session.payment_status !== "paid") {
      storedCheckout.status = "payment_not_confirmed";
      storedCheckout.paymentStatus = session.payment_status;
      storedCheckout.updatedAt = nowIso();
      saveDb(db);

      return sendJson(res, 402, {
        ok: false,
        paid: false,
        reason: "STRIPE_PAYMENT_NOT_CONFIRMED",
        error: "Stripe has not confirmed payment yet. Broadcast Credits were not added.",
        checkout: storedCheckout,
        stripePaymentStatus: session.payment_status,
      });
    }

    const pack = getBroadcastCreditPackById(storedCheckout.packId);
    if (!pack) {
      return sendJson(res, 500, {
        ok: false,
        error: "Stored checkout pack is no longer valid.",
        checkout: storedCheckout,
      });
    }

    const wallet = ensureWallet(db, storedCheckout.userId, storedCheckout.plan);
    addBroadcastPackToWallet(wallet, pack);

    const transactionId = "stripe-bpack-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    db.broadcastPackTransactions[transactionId] = {
      transactionId,
      status: "credited",
      source: "stripe",
      checkoutId: storedCheckout.checkoutId,
      stripeSessionId: storedCheckout.stripeSessionId,
      stripePaymentStatus: session.payment_status,
      userId: storedCheckout.userId,
      plan: storedCheckout.plan,
      packId: pack.id,
      credits: pack.credits,
      priceUsd: pack.priceUsd,
      createdAt: nowIso(),
    };

    storedCheckout.status = "credited";
    storedCheckout.paymentStatus = session.payment_status;
    storedCheckout.creditedTransactionId = transactionId;
    storedCheckout.updatedAt = nowIso();

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      paid: true,
      credited: true,
      transactionId,
      checkout: storedCheckout,
      pack,
      wallet,
    });
  }

  // PASS_SERVER_8794_LIVE_TOKEN_DEBIT_ROUTE_1A
  // SERVER 8794 — Debit live tokens while a live session is running.
  if (method === "POST" && pathname === "/api/usage/live-debit") {
    const body = await readJsonBody(req);

    if (body.__parseError) {
      return sendJson(res, 400, {
        ok: false,
        error: "Invalid JSON body.",
        detail: body.__parseError,
        raw: body.__rawBody,
      });
    }

    const db = loadDb();

    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const wallet = ensureWallet(db, userId, plan);

    const seconds = Math.max(1, Number(body.seconds || 60));
    const minutes = Math.max(1 / 60, seconds / 60);
    const viewerCount = Math.max(0, Number(body.viewerCount || body.viewers || 0));
    const screenShare = Boolean(body.screenShare || body.screenShareOn);

    const hostCost = BURN_MODEL.hostTokensPerMinute * minutes;
    const viewerCost = BURN_MODEL.viewerTokensPerViewerPerMinute * viewerCount * minutes;
    const multiplier = screenShare ? BURN_MODEL.screenShareMultiplier : 1;

    const tokensToDebit = Math.ceil((hostCost + viewerCost) * multiplier);

    const currentBalance =
      plan === "FREE"
        ? Number(wallet.balance ?? wallet.liveTokensBalance ?? 0)
        : Number(wallet.liveTokensBalance ?? wallet.balance ?? 0);

    if (currentBalance < tokensToDebit) {
      wallet.status = "exhausted";
      wallet.updatedAt = nowIso();
      saveDb(db);

      return sendJson(res, 402, {
        ok: false,
        blocked: true,
        reason: "LIVE_TOKENS_EXHAUSTED",
        message: "Live tokens exhausted. Upgrade or add credits to continue.",
        userId,
        plan,
        tokensToDebit,
        availableTokens: currentBalance,
        wallet,
      });
    }

    const nextBalance = Math.max(0, currentBalance - tokensToDebit);

    if (plan === "FREE") {
      wallet.balance = nextBalance;
      wallet.liveTokensBalance = nextBalance;
    } else {
      wallet.liveTokensBalance = nextBalance;
    }

    wallet.lifetimeDebited = Number(wallet.lifetimeDebited || 0) + tokensToDebit;
    wallet.updatedAt = nowIso();

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      debited: true,
      userId,
      plan,
      roomId: body.roomId || "main-hall",
      sessionId: body.sessionId || "",
      seconds,
      viewerCount,
      screenShare,
      tokensDebited: tokensToDebit,
      remainingTokens: nextBalance,
      burnModel: BURN_MODEL,
      wallet,
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Route not found.",
    method,
    pathname,
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("SERVER 8794 error:", err);
    sendJson(res, 500, {
      ok: false,
      error: "SERVER 8794 internal error.",
      detail: err.message,
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AGV Usage Wallet Server running on ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Stripe configured: ${Boolean(stripe)}`);
});
