const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.FREE_TOKEN_PORT || process.env.PORT || 8794);
const DATA_FILE = path.join(__dirname, "agv-free-token-wallets.json");

const STARTING_FREE_TOKENS = 150000;

// AGV cost model
const HOST_TOKENS_PER_MINUTE = 60;
const VIEWER_TOKENS_PER_VIEWER_PER_MINUTE = 6;
const SCREEN_SHARE_MULTIPLIER = 2;

// PASS_USAGE_WALLET_MODEL_1A
// SERVER — AGV Usage Wallet Model: Live Tokens + Broadcast Credits.
const PLAN_USAGE_ALLOWANCES = {
  FREE: {
    monthlyLiveTokens: STARTING_FREE_TOKENS,
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
  {
    id: "starter",
    name: "Starter Broadcast Pack",
    credits: 25000,
    priceUsd: 59,
  },
  {
    id: "growth",
    name: "Growth Broadcast Pack",
    credits: 100000,
    priceUsd: 199,
  },
  {
    id: "event",
    name: "Event Broadcast Pack",
    credits: 500000,
    priceUsd: 799,
  },
  {
    id: "convention",
    name: "Convention Broadcast Pack",
    credits: 1500000,
    priceUsd: 1999,
  },
];

function getPlanUsageAllowance(plan) {
  const normalizedPlan = normalizePlan(plan);
  return PLAN_USAGE_ALLOWANCES[normalizedPlan] || PLAN_USAGE_ALLOWANCES.FREE;
}

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function calculateBroadcastCreditsNeeded({ expectedViewers, expectedMinutes }) {
  const viewers = positiveNumber(expectedViewers, 0);
  const minutes = positiveNumber(expectedMinutes, 0);
  return Math.ceil(viewers * minutes);
}

function calculateLiveTokensNeeded({ interactiveParticipants, expectedMinutes, screenShare }) {
  const participants = positiveNumber(interactiveParticipants, 1);
  const minutes = positiveNumber(expectedMinutes, 0);

  const hostCost = HOST_TOKENS_PER_MINUTE * minutes;
  const participantCost =
    Math.max(0, participants - 1) *
    VIEWER_TOKENS_PER_VIEWER_PER_MINUTE *
    minutes;

  const multiplier = screenShare ? SCREEN_SHARE_MULTIPLIER : 1;

  return Math.ceil((hostCost + participantCost) * multiplier);
}

function getRecommendedBroadcastPack(shortage) {
  const needed = Math.max(0, Number(shortage || 0));

  if (needed <= 0) {
    return null;
  }

  return (
    BROADCAST_CREDIT_PACKS.find((pack) => pack.credits >= needed) || {
      id: "custom",
      name: "Custom Broadcast Quote",
      credits: needed,
      priceUsd: null,
    }
  );
}

function ensureUsageWalletFields(wallet, plan) {
  const normalizedPlan = normalizePlan(plan);
  const allowance = getPlanUsageAllowance(normalizedPlan);

  wallet.monthlyLiveTokens = allowance.monthlyLiveTokens;
  wallet.monthlyBroadcastCredits = allowance.monthlyBroadcastCredits;

  if (typeof wallet.liveTokensBalance !== "number") {
    wallet.liveTokensBalance = allowance.monthlyLiveTokens;
  }

  if (typeof wallet.broadcastCreditsBalance !== "number") {
    wallet.broadcastCreditsBalance = allowance.monthlyBroadcastCredits;
  }

  if (typeof wallet.purchasedBroadcastCredits !== "number") {
    wallet.purchasedBroadcastCredits = 0;
  }

  if (typeof wallet.lifetimeBroadcastCreditsUsed !== "number") {
    wallet.lifetimeBroadcastCreditsUsed = 0;
  }

  return wallet;
}

function nowIso() {
  return new Date().toISOString();
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { wallets: {}, sessions: {} };
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    return {
      wallets: parsed.wallets && typeof parsed.wallets === "object" ? parsed.wallets : {},
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { wallets: {}, sessions: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function getQuery(req) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  return {
    pathname: url.pathname,
    searchParams: url.searchParams,
  };
}

function normalizeUserId(value) {
  const raw = value == null ? "" : String(value).trim();
  return raw || "local-free-user";
}

function normalizePlan(value) {
  const raw = value == null ? "FREE" : String(value).trim().toUpperCase();
  return raw || "FREE";
}

function ensureWallet(db, userId, plan) {
  const normalizedPlan = normalizePlan(plan);
  const id = normalizeUserId(userId);

  if (!db.wallets[id]) {
    db.wallets[id] = {
      userId: id,
      plan: normalizedPlan,
      startingBalance: normalizedPlan === "FREE" ? STARTING_FREE_TOKENS : null,
      balance: normalizedPlan === "FREE" ? STARTING_FREE_TOKENS : null,
      lifetimeDebited: 0,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  const wallet = db.wallets[id];

  wallet.plan = normalizedPlan;
  wallet.updatedAt = nowIso();

  // PASS_USAGE_WALLET_MODEL_1A
  ensureUsageWalletFields(wallet, normalizedPlan);

  if (normalizedPlan === "FREE" && typeof wallet.balance !== "number") {
    wallet.startingBalance = STARTING_FREE_TOKENS;
    wallet.balance = STARTING_FREE_TOKENS;
  }

  return wallet;
}

function isFreePlan(plan) {
  return normalizePlan(plan) === "FREE";
}

function calculateDebit({ seconds, viewerCount, screenShare }) {
  const safeSeconds = Math.max(0, Number(seconds || 0));
  const safeViewers = Math.max(0, Number(viewerCount || 0));
  const minutes = safeSeconds / 60;

  const multiplier = screenShare ? SCREEN_SHARE_MULTIPLIER : 1;

  const hostCost = HOST_TOKENS_PER_MINUTE * minutes;
  const viewerCost = VIEWER_TOKENS_PER_VIEWER_PER_MINUTE * safeViewers * minutes;
  const rawCost = (hostCost + viewerCost) * multiplier;

  return Math.ceil(rawCost);
}

function publicWallet(wallet) {
  return {
    userId: wallet.userId,
    plan: wallet.plan,
    startingBalance: wallet.startingBalance,
    balance: wallet.balance,
    lifetimeDebited: wallet.lifetimeDebited,
    status: wallet.status,
    createdAt: wallet.createdAt,
    monthlyLiveTokens: wallet.monthlyLiveTokens,
    liveTokensBalance: wallet.liveTokensBalance,
    monthlyBroadcastCredits: wallet.monthlyBroadcastCredits,
    broadcastCreditsBalance: wallet.broadcastCreditsBalance,
    purchasedBroadcastCredits: wallet.purchasedBroadcastCredits,
    lifetimeBroadcastCreditsUsed: wallet.lifetimeBroadcastCreditsUsed,
    updatedAt: wallet.updatedAt,
  };
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = getQuery(req);

  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/health") {
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
      burnModel: {
        hostTokensPerMinute: HOST_TOKENS_PER_MINUTE,
        viewerTokensPerViewerPerMinute: VIEWER_TOKENS_PER_VIEWER_PER_MINUTE,
        screenShareMultiplier: SCREEN_SHARE_MULTIPLIER,
      },
    });
  }

  if (req.method === "GET" && pathname === "/api/free-tokens/wallet") {
    const db = loadDb();
    const userId = normalizeUserId(searchParams.get("userId"));
    const plan = normalizePlan(searchParams.get("plan"));

    const wallet = ensureWallet(db, userId, plan);
    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      wallet: publicWallet(wallet),
      canStartBroadcast: !isFreePlan(plan) || wallet.balance > 0,
    });
  }

  if (req.method === "POST" && pathname === "/api/free-tokens/start-session") {
    const body = await readBody(req);
    const db = loadDb();

    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const roomId = String(body.roomId || "main-hall");

    const wallet = ensureWallet(db, userId, plan);

    if (isFreePlan(plan) && wallet.balance <= 0) {
      saveDb(db);
      return sendJson(res, 402, {
        ok: false,
        blocked: true,
        reason: "FREE_TOKENS_EXHAUSTED",
        message: "Your free AGV Live Tokens have been used. Upgrade to continue broadcasting.",
        wallet: publicWallet(wallet),
      });
    }

    const sessionId =
      "agv-live-session-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8);

    db.sessions[sessionId] = {
      sessionId,
      userId,
      plan,
      roomId,
      status: "live",
      startedAt: nowIso(),
      lastDebitAt: nowIso(),
      endedAt: null,
      tokensDebited: 0,
    };

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      allowed: true,
      sessionId,
      wallet: publicWallet(wallet),
    });
  }

  if (req.method === "POST" && pathname === "/api/free-tokens/debit") {
    const body = await readBody(req);
    const db = loadDb();

    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const sessionId = String(body.sessionId || "");
    const roomId = String(body.roomId || "main-hall");

    const wallet = ensureWallet(db, userId, plan);

    if (!isFreePlan(plan)) {
      saveDb(db);
      return sendJson(res, 200, {
        ok: true,
        bypassed: true,
        reason: "PAID_PLAN_NOT_DEBITED",
        debit: 0,
        wallet: publicWallet(wallet),
      });
    }

    const debit = calculateDebit({
      seconds: body.seconds,
      viewerCount: body.viewerCount,
      screenShare: Boolean(body.screenShare),
    });

    wallet.balance = Math.max(0, Number(wallet.balance || 0) - debit);
    wallet.lifetimeDebited = Number(wallet.lifetimeDebited || 0) + debit;
    wallet.updatedAt = nowIso();

    if (sessionId && db.sessions[sessionId]) {
      db.sessions[sessionId].tokensDebited =
        Number(db.sessions[sessionId].tokensDebited || 0) + debit;
      db.sessions[sessionId].lastDebitAt = nowIso();

      if (wallet.balance <= 0) {
        db.sessions[sessionId].status = "ended";
        db.sessions[sessionId].endedAt = nowIso();
      }
    } else if (sessionId) {
      db.sessions[sessionId] = {
        sessionId,
        userId,
        plan,
        roomId,
        status: wallet.balance <= 0 ? "ended" : "live",
        startedAt: nowIso(),
        lastDebitAt: nowIso(),
        endedAt: wallet.balance <= 0 ? nowIso() : null,
        tokensDebited: debit,
      };
    }

    saveDb(db);

    return sendJson(res, wallet.balance <= 0 ? 402 : 200, {
      ok: wallet.balance > 0,
      debit,
      blocked: wallet.balance <= 0,
      reason: wallet.balance <= 0 ? "FREE_TOKENS_EXHAUSTED" : null,
      message:
        wallet.balance <= 0
          ? "Your free AGV Live Tokens have been used. Upgrade to continue broadcasting."
          : "Free AGV Live Tokens debited.",
      wallet: publicWallet(wallet),
    });
  }


  // PASS_USAGE_WALLET_MODEL_1A
  // SERVER — Unified AGV usage wallet endpoint.
  if (req.method === "GET" && pathname === "/api/usage/wallet") {
    const db = loadDb();
    const userId = normalizeUserId(searchParams.get("userId"));
    const plan = normalizePlan(searchParams.get("plan"));

    const wallet = ensureWallet(db, userId, plan);
    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      usageWalletModel: true,
      wallet: publicWallet(wallet),
      plans: PLAN_USAGE_ALLOWANCES,
      broadcastCreditPacks: BROADCAST_CREDIT_PACKS,
    });
  }

  // PASS_USAGE_WALLET_MODEL_1A
  // SERVER — Estimate LiveKit + Cloudflare usage before event starts.
  if (req.method === "POST" && pathname === "/api/usage/estimate-event") {
    const body = await readBody(req);
    const db = loadDb();

    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const wallet = ensureWallet(db, userId, plan);

    const expectedViewers = positiveNumber(body.expectedViewers, 0);
    const expectedMinutes = positiveNumber(body.expectedMinutes, 0);
    const interactiveParticipants = positiveNumber(body.interactiveParticipants, 1);
    const screenShare = Boolean(body.screenShare);

    const broadcastCreditsNeeded = calculateBroadcastCreditsNeeded({
      expectedViewers,
      expectedMinutes,
    });

    const liveTokensNeeded = calculateLiveTokensNeeded({
      interactiveParticipants,
      expectedMinutes,
      screenShare,
    });

    const availableBroadcastCredits = Number(wallet.broadcastCreditsBalance || 0);
    const availableLiveTokens =
      isFreePlan(plan) ? Number(wallet.balance || 0) : Number(wallet.liveTokensBalance || 0);

    const broadcastShortage = Math.max(0, broadcastCreditsNeeded - availableBroadcastCredits);
    const liveTokenShortage = Math.max(0, liveTokensNeeded - availableLiveTokens);

    const cloudflareAllowed = !isFreePlan(plan);
    const broadcastAllowed = cloudflareAllowed && broadcastShortage <= 0;
    const liveKitAllowed = liveTokenShortage <= 0;

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      usageWalletModel: true,
      eventEstimate: {
        expectedViewers,
        expectedMinutes,
        interactiveParticipants,
        screenShare,
        broadcastCreditsNeeded,
        liveTokensNeeded,
      },
      balances: {
        availableBroadcastCredits,
        availableLiveTokens,
      },
      allowed: {
        cloudflareAllowed,
        broadcastAllowed,
        liveKitAllowed,
      },
      shortage: {
        broadcastCredits: broadcastShortage,
        liveTokens: liveTokenShortage,
      },
      recommendedBroadcastPack: getRecommendedBroadcastPack(broadcastShortage),
      wallet: publicWallet(wallet),
    });
  }

  // PASS_USAGE_WALLET_MODEL_1A
  // SERVER — Gate Cloudflare start before AGV exposes costly public broadcast.
  if (req.method === "POST" && pathname === "/api/usage/start-broadcast-gate") {
    const body = await readBody(req);
    const db = loadDb();

    const userId = normalizeUserId(body.userId);
    const plan = normalizePlan(body.plan);
    const wallet = ensureWallet(db, userId, plan);

    const requiredBroadcastCredits =
      positiveNumber(body.requiredBroadcastCredits, 0) ||
      calculateBroadcastCreditsNeeded({
        expectedViewers: body.expectedViewers,
        expectedMinutes: body.expectedMinutes,
      });

    const availableBroadcastCredits = Number(wallet.broadcastCreditsBalance || 0);
    const shortage = Math.max(0, requiredBroadcastCredits - availableBroadcastCredits);

    if (isFreePlan(plan)) {
      saveDb(db);
      return sendJson(res, 402, {
        ok: false,
        blocked: true,
        reason: "FREE_PLAN_CLOUDFLARE_NOT_INCLUDED",
        message:
          "Free plans do not include Cloudflare public broadcast delivery. Upgrade and add Broadcast Credits to continue.",
        requiredBroadcastCredits,
        availableBroadcastCredits,
        shortage,
        recommendedBroadcastPack: getRecommendedBroadcastPack(requiredBroadcastCredits),
        wallet: publicWallet(wallet),
      });
    }

    if (shortage > 0) {
      saveDb(db);
      return sendJson(res, 402, {
        ok: false,
        blocked: true,
        reason: "BROADCAST_CREDITS_REQUIRED",
        message:
          "This event needs more AGV Broadcast Credits before Cloudflare public broadcast can start.",
        requiredBroadcastCredits,
        availableBroadcastCredits,
        shortage,
        recommendedBroadcastPack: getRecommendedBroadcastPack(shortage),
        wallet: publicWallet(wallet),
      });
    }

    saveDb(db);
    return sendJson(res, 200, {
      ok: true,
      allowed: true,
      usageWalletModel: true,
      message: "Broadcast Credits available. Cloudflare public broadcast may start.",
      requiredBroadcastCredits,
      availableBroadcastCredits,
      wallet: publicWallet(wallet),
    });
  }

  if (req.method === "POST" && pathname === "/api/free-tokens/end-session") {
    const body = await readBody(req);
    const db = loadDb();

    const sessionId = String(body.sessionId || "");

    if (sessionId && db.sessions[sessionId]) {
      db.sessions[sessionId].status = "ended";
      db.sessions[sessionId].endedAt = nowIso();
      db.sessions[sessionId].updatedAt = nowIso();
    }

    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      sessionId,
      message: "AGV free token session ended.",
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found",
    path: pathname,
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`AGV Free Token Wallet Server running on ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
