"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = String(
  process.env.AGV_ANPE_HOST || "127.0.0.1"
).trim();

const PORT = Number(
  process.env.AGV_ANPE_PORT || 8802
);

const DATA_FILE = path.join(
  __dirname,
  "agv-network-playout.json"
);

const ADMIN_TOKEN = String(
  process.env.AGV_ANPE_ADMIN_TOKEN || ""
).trim();

const MAX_BODY_BYTES = 1_000_000;

const ALLOWED_ORIGINS = new Set(
  String(
    process.env.AGV_ANPE_ALLOWED_ORIGINS ||
      [
        "http://127.0.0.1:5175",
        "http://localhost:5175",
        "https://www.agvision.show",
        "https://agvision.show",
        "https://agv-client.vercel.app",
      ].join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const OFFER_TYPES = new Set([
  "AIRTIME_SPOT",
  "PROGRAM_SPONSORSHIP",
  "CHANNEL_SPONSORSHIP",
  "PROGRAMMING_BLOCK",
  "PRODUCTION_SERVICE",
]);

const CAMPAIGN_STATUSES = new Set([
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
]);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function cleanId(value, fallbackPrefix = "item") {
  const cleaned = cleanText(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    cleaned ||
    `${fallbackPrefix}-${crypto.randomUUID()}`
  );
}

function nonnegativeInteger(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }

  return Math.floor(number);
}

function nullableIso(value) {
  const raw = cleanText(value, 80);

  if (!raw) {
    return "";
  }

  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString();
}

function defaultRateCards() {
  return [
    {
      id: "airtime-spot-30",
      type: "AIRTIME_SPOT",
      title: "30-Second Airtime Spot",
      description:
        "One approved 30-second advertising placement in an AGV Network commercial break.",
      durationSeconds: 30,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "airtime-spot-60",
      type: "AIRTIME_SPOT",
      title: "60-Second Airtime Spot",
      description:
        "One approved 60-second advertising placement in an AGV Network commercial break.",
      durationSeconds: 60,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "program-sponsorship",
      type: "PROGRAM_SPONSORSHIP",
      title: "Program Sponsorship",
      description:
        "Sponsor identification and approved campaign placement connected to one AGV Network program.",
      durationSeconds: 0,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "channel-sponsorship",
      type: "CHANNEL_SPONSORSHIP",
      title: "Channel Sponsorship",
      description:
        "Time-limited sponsorship of an approved AGV Network channel.",
      durationSeconds: 0,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "programming-block-30",
      type: "PROGRAMMING_BLOCK",
      title: "30-Minute Programming Block",
      description:
        "A scheduled 30-minute rights-cleared programming block on an approved AGV Network channel.",
      durationSeconds: 1800,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "programming-block-60",
      type: "PROGRAMMING_BLOCK",
      title: "60-Minute Programming Block",
      description:
        "A scheduled 60-minute rights-cleared programming block on an approved AGV Network channel.",
      durationSeconds: 3600,
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
  ];
}

function defaultProductionServices() {
  return [
    {
      id: "production-consultation",
      type: "PRODUCTION_SERVICE",
      title: "Production Consultation",
      description:
        "Planning consultation for an AGV Network program, campaign, or programming block.",
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "remote-live-production",
      type: "PRODUCTION_SERVICE",
      title: "Remote Live Production",
      description:
        "Remote production support for an approved AGV Network live program.",
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
    {
      id: "commercial-spot-production",
      type: "PRODUCTION_SERVICE",
      title: "Commercial Spot Production",
      description:
        "Production of an approved sponsor or advertiser message for AGV Network review.",
      priceCents: 0,
      currency: "USD",
      quoteRequired: true,
      enabled: true,
      salesStatus: "DRAFT",
    },
  ];
}

function defaultData() {
  const timestamp = nowIso();

  return {
    schemaVersion: 1,

    service:
      "AGV Network Playout & Enterprise Revenue Engine",

    viewerAccessModel: "FREE_TO_VIEW",

    commercialSalesEnabled: false,
    publicOrderIntakeEnabled: false,
    playoutEnabled: false,

    currency: "USD",

    rateCards: defaultRateCards(),

    productionServices:
      defaultProductionServices(),

    campaigns: [],

    proofOfPlay: [],

    auditLog: [
      {
        id: crypto.randomUUID(),
        action: "ANPE_FOUNDATION_CREATED",
        actor: "SYSTEM",
        at: timestamp,
        details:
          "Commercial inventory foundation created with sales and playout disabled.",
      },
    ],

    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeOffer(
  item,
  index,
  fallbackType
) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  const typeCandidate = cleanText(
    source.type || fallbackType,
    80
  ).toUpperCase();

  const type = OFFER_TYPES.has(typeCandidate)
    ? typeCandidate
    : fallbackType;

  return {
    id: cleanId(
      source.id || source.title,
      `${fallbackType.toLowerCase()}-${index + 1}`
    ),

    type,

    title: cleanText(
      source.title ||
        `${fallbackType} ${index + 1}`,
      180
    ),

    description: cleanText(
      source.description,
      1000
    ),

    durationSeconds:
      nonnegativeInteger(
        source.durationSeconds
      ),

    priceCents:
      nonnegativeInteger(
        source.priceCents
      ),

    currency: cleanText(
      source.currency || "USD",
      10
    ).toUpperCase(),

    quoteRequired:
      source.quoteRequired !== false,

    enabled:
      source.enabled !== false,

    salesStatus: cleanText(
      source.salesStatus || "DRAFT",
      40
    ).toUpperCase(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function normalizeCampaign(item, index) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  const requestedStatus = cleanText(
    source.status || "DRAFT",
    60
  ).toUpperCase();

  const status =
    CAMPAIGN_STATUSES.has(requestedStatus)
      ? requestedStatus
      : "DRAFT";

  return {
    id: cleanId(
      source.id,
      `campaign-${index + 1}`
    ),

    campaignName: cleanText(
      source.campaignName ||
        source.name ||
        `Campaign ${index + 1}`,
      180
    ),

    buyerName: cleanText(
      source.buyerName,
      180
    ),

    buyerEmail: cleanText(
      source.buyerEmail,
      254
    ).toLowerCase(),

    organization: cleanText(
      source.organization,
      180
    ),

    offerType: cleanText(
      source.offerType,
      80
    ).toUpperCase(),

    offerId: cleanId(
      source.offerId,
      "offer"
    ),

    stationId: cleanId(
      source.stationId,
      "station"
    ),

    programId: cleanId(
      source.programId,
      "program"
    ),

    startAt:
      nullableIso(source.startAt),

    endAt:
      nullableIso(source.endAt),

    quantity: Math.max(
      1,
      nonnegativeInteger(
        source.quantity || 1
      )
    ),

    quotedAmountCents:
      nonnegativeInteger(
        source.quotedAmountCents
      ),

    currency: cleanText(
      source.currency || "USD",
      10
    ).toUpperCase(),

    status,

    rightsClearanceStatus: cleanText(
      source.rightsClearanceStatus ||
        "NOT_REVIEWED",
      60
    ).toUpperCase(),

    creativeApprovalStatus: cleanText(
      source.creativeApprovalStatus ||
        "NOT_REVIEWED",
      60
    ).toUpperCase(),

    paymentStatus: cleanText(
      source.paymentStatus ||
        "NOT_STARTED",
      60
    ).toUpperCase(),

    schedulingStatus: cleanText(
      source.schedulingStatus ||
        "NOT_SCHEDULED",
      60
    ).toUpperCase(),

    notes: cleanText(
      source.notes,
      2000
    ),

    createdAt:
      nullableIso(source.createdAt) ||
      nowIso(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function normalizeData(value) {
  const source =
    value && typeof value === "object"
      ? value
      : defaultData();

  const rateCardSource =
    Array.isArray(source.rateCards)
      ? source.rateCards
      : defaultRateCards();

  const serviceSource =
    Array.isArray(
      source.productionServices
    )
      ? source.productionServices
      : defaultProductionServices();

  const campaignSource =
    Array.isArray(source.campaigns)
      ? source.campaigns
      : [];

  return {
    schemaVersion: 1,

    service:
      "AGV Network Playout & Enterprise Revenue Engine",

    viewerAccessModel:
      "FREE_TO_VIEW",

    commercialSalesEnabled:
      source.commercialSalesEnabled === true,

    publicOrderIntakeEnabled:
      source.publicOrderIntakeEnabled === true,

    playoutEnabled:
      source.playoutEnabled === true,

    currency: cleanText(
      source.currency || "USD",
      10
    ).toUpperCase(),

    rateCards:
      rateCardSource.map(
        (item, index) =>
          normalizeOffer(
            item,
            index,
            "AIRTIME_SPOT"
          )
      ),

    productionServices:
      serviceSource.map(
        (item, index) =>
          normalizeOffer(
            item,
            index,
            "PRODUCTION_SERVICE"
          )
      ),

    campaigns:
      campaignSource.map(
        normalizeCampaign
      ),

    proofOfPlay:
      Array.isArray(source.proofOfPlay)
        ? source.proofOfPlay
        : [],

    auditLog:
      Array.isArray(source.auditLog)
        ? source.auditLog
        : [],

    createdAt:
      nullableIso(source.createdAt) ||
      nowIso(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function writeData(data) {
  const normalized =
    normalizeData(data);

  const temporaryFile =
    `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(
      normalized,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    DATA_FILE
  );

  return normalized;
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return writeData(
      defaultData()
    );
  }

  try {
    const raw = fs.readFileSync(
      DATA_FILE,
      "utf8"
    );

    return normalizeData(
      JSON.parse(raw)
    );
  } catch (error) {
    const backupFile =
      `${DATA_FILE}.CORRUPT.${Date.now()}`;

    fs.copyFileSync(
      DATA_FILE,
      backupFile
    );

    throw new Error(
      [
        "ANPE data file could not be read.",
        `Corrupt copy preserved at ${backupFile}.`,
        error.message,
      ].join(" ")
    );
  }
}

function addAudit(
  data,
  action,
  actor,
  details = ""
) {
  data.auditLog.unshift({
    id: crypto.randomUUID(),
    action: cleanText(
      action,
      100
    ).toUpperCase(),
    actor: cleanText(
      actor || "UNKNOWN",
      254
    ),
    at: nowIso(),
    details: cleanText(
      details,
      2000
    ),
  });

  data.auditLog =
    data.auditLog.slice(0, 1000);

  data.updatedAt = nowIso();
}

function applyCors(req, res) {
  const origin = cleanText(
    req.headers.origin,
    500
  );

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Vary",
      "Origin"
    );
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, OPTIONS"
  );
}

function sendJson(
  res,
  statusCode,
  payload
) {
  const body = JSON.stringify(
    payload,
    null,
    2
  );

  res.writeHead(statusCode, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Content-Length":
      Buffer.byteLength(body),

    "Cache-Control":
      "no-store",

    "X-Content-Type-Options":
      "nosniff",
  });

  res.end(body);
}

function readJsonBody(req) {
  return new Promise(
    (resolve, reject) => {
      const chunks = [];
      let size = 0;

      req.on("data", (chunk) => {
        size += chunk.length;

        if (size > MAX_BODY_BYTES) {
          reject(
            new Error(
              "Request body exceeds the ANPE size limit."
            )
          );

          req.destroy();
          return;
        }

        chunks.push(chunk);
      });

      req.on("end", () => {
        if (!chunks.length) {
          resolve({});
          return;
        }

        try {
          resolve(
            JSON.parse(
              Buffer.concat(chunks)
                .toString("utf8")
            )
          );
        } catch (error) {
          reject(
            new Error(
              `Invalid JSON body: ${error.message}`
            )
          );
        }
      });

      req.on("error", reject);
    }
  );
}

function authorizeAdmin(req) {
  if (!ADMIN_TOKEN) {
    return {
      ok: false,
      status: 503,
      error:
        "AGV_ANPE_ADMIN_TOKEN is not configured. Administrative routes are locked.",
    };
  }

  const authorization =
    cleanText(
      req.headers.authorization,
      4000
    );

  const supplied =
    authorization
      .toLowerCase()
      .startsWith("bearer ")
      ? authorization
          .slice(7)
          .trim()
      : "";

  if (!supplied) {
    return {
      ok: false,
      status: 401,
      error:
        "Missing ANPE administrator bearer token.",
    };
  }

  const expectedBuffer =
    Buffer.from(ADMIN_TOKEN);

  const suppliedBuffer =
    Buffer.from(supplied);

  const matches =
    expectedBuffer.length ===
      suppliedBuffer.length &&
    crypto.timingSafeEqual(
      expectedBuffer,
      suppliedBuffer
    );

  if (!matches) {
    return {
      ok: false,
      status: 403,
      error:
        "Invalid ANPE administrator bearer token.",
    };
  }

  return {
    ok: true,
    actor: "ANPE_ADMIN",
  };
}

function publicCatalog(data) {
  return {
    viewerAccessModel:
      data.viewerAccessModel,

    commercialSalesEnabled:
      data.commercialSalesEnabled,

    publicOrderIntakeEnabled:
      data.publicOrderIntakeEnabled,

    currency:
      data.currency,

    offers:
      data.rateCards.filter(
        (item) => item.enabled
      ),

    productionServices:
      data.productionServices.filter(
        (item) => item.enabled
      ),

    updatedAt:
      data.updatedAt,
  };
}

async function handleRequest(
  req,
  res
) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url,
    `http://${
      req.headers.host ||
      `${HOST}:${PORT}`
    }`
  );

  const pathname = url.pathname;

  if (
    req.method === "GET" &&
    pathname === "/api/health"
  ) {
    const data = readData();

    sendJson(res, 200, {
      ok: true,
      service: data.service,
      port: PORT,

      viewerAccessModel:
        data.viewerAccessModel,

      commercialSalesEnabled:
        data.commercialSalesEnabled,

      publicOrderIntakeEnabled:
        data.publicOrderIntakeEnabled,

      playoutEnabled:
        data.playoutEnabled,

      adminRoutesLocked:
        !ADMIN_TOKEN,

      dataFile:
        DATA_FILE,

      rateCardCount:
        data.rateCards.length,

      productionServiceCount:
        data.productionServices.length,

      campaignCount:
        data.campaigns.length,

      now:
        nowIso(),
    });

    return;
  }

  if (
    req.method === "GET" &&
    pathname ===
      "/api/network/commercial/catalog"
  ) {
    const data = readData();

    sendJson(res, 200, {
      ok: true,
      catalog:
        publicCatalog(data),
    });

    return;
  }

  if (
    pathname.startsWith(
      "/api/admin/"
    )
  ) {
    const auth =
      authorizeAdmin(req);

    if (!auth.ok) {
      sendJson(
        res,
        auth.status,
        {
          ok: false,
          error: auth.error,
        }
      );

      return;
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/commercial/state"
    ) {
      sendJson(res, 200, {
        ok: true,
        state: readData(),
      });

      return;
    }

    if (
      req.method === "PUT" &&
      pathname ===
        "/api/admin/commercial/rate-cards"
    ) {
      const body =
        await readJsonBody(req);

      if (
        !Array.isArray(
          body.rateCards
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A rateCards array is required.",
        });

        return;
      }

      const data = readData();

      data.rateCards =
        body.rateCards.map(
          (item, index) =>
            normalizeOffer(
              item,
              index,
              "AIRTIME_SPOT"
            )
        );

      addAudit(
        data,
        "RATE_CARDS_UPDATED",
        auth.actor,
        `${data.rateCards.length} rate cards saved.`
      );

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,
        rateCards:
          saved.rateCards,
        updatedAt:
          saved.updatedAt,
      });

      return;
    }

    if (
      req.method === "PUT" &&
      pathname ===
        "/api/admin/commercial/production-services"
    ) {
      const body =
        await readJsonBody(req);

      if (
        !Array.isArray(
          body.productionServices
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A productionServices array is required.",
        });

        return;
      }

      const data = readData();

      data.productionServices =
        body.productionServices.map(
          (item, index) =>
            normalizeOffer(
              item,
              index,
              "PRODUCTION_SERVICE"
            )
        );

      addAudit(
        data,
        "PRODUCTION_SERVICES_UPDATED",
        auth.actor,
        `${data.productionServices.length} production services saved.`
      );

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,

        productionServices:
          saved.productionServices,

        updatedAt:
          saved.updatedAt,
      });

      return;
    }

    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/commercial/campaigns"
    ) {
      const data = readData();

      sendJson(res, 200, {
        ok: true,
        campaigns:
          data.campaigns,
        count:
          data.campaigns.length,
      });

      return;
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/commercial/campaigns"
    ) {
      const body =
        await readJsonBody(req);

      const data = readData();

      const campaign =
        normalizeCampaign(
          {
            ...body,

            id:
              body.id ||
              `campaign-${crypto.randomUUID()}`,

            status: "DRAFT",

            createdAt:
              nowIso(),

            updatedAt:
              nowIso(),
          },

          data.campaigns.length
        );

      data.campaigns.unshift(
        campaign
      );

      addAudit(
        data,
        "CAMPAIGN_CREATED",
        auth.actor,
        campaign.id
      );

      const saved =
        writeData(data);

      sendJson(res, 201, {
        ok: true,
        campaign:
          saved.campaigns[0],
      });

      return;
    }

    const statusMatch =
      pathname.match(
        /^\/api\/admin\/commercial\/campaigns\/([^/]+)\/status$/
      );

    if (
      req.method === "PATCH" &&
      statusMatch
    ) {
      const body =
        await readJsonBody(req);

      const requestedStatus =
        cleanText(
          body.status,
          60
        ).toUpperCase();

      if (
        !CAMPAIGN_STATUSES.has(
          requestedStatus
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown campaign status.",

          allowedStatuses:
            Array.from(
              CAMPAIGN_STATUSES
            ),
        });

        return;
      }

      const campaignId =
        cleanId(
          decodeURIComponent(
            statusMatch[1]
          ),
          "campaign"
        );

      const data = readData();

      const campaign =
        data.campaigns.find(
          (item) =>
            item.id === campaignId
        );

      if (!campaign) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Campaign was not found.",
        });

        return;
      }

      campaign.status =
        requestedStatus;

      campaign.updatedAt =
        nowIso();

      addAudit(
        data,
        "CAMPAIGN_STATUS_UPDATED",
        auth.actor,
        `${campaign.id}: ${requestedStatus}`
      );

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,

        campaign:
          saved.campaigns.find(
            (item) =>
              item.id === campaignId
          ),
      });

      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error:
      "ANPE route not found.",
  });
}

function startServer() {
  readData();

  const server =
    http.createServer(
      (req, res) => {
        handleRequest(req, res)
          .catch((error) => {
            console.error(
              "ANPE REQUEST FAILED:",
              error
            );

            if (!res.headersSent) {
              sendJson(res, 500, {
                ok: false,
                error:
                  "ANPE request failed.",
                detail:
                  error.message,
              });
            } else {
              res.end();
            }
          });
      }
    );

  server.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `AGV Network Playout & Enterprise Revenue Engine running on http://${HOST}:${PORT}`
      );

      console.log(
        `ANPE data file: ${DATA_FILE}`
      );

      console.log(
        "Viewer access model: FREE_TO_VIEW"
      );

      console.log(
        `Administrative routes locked: ${!ADMIN_TOKEN}`
      );

      console.log(
        "Commercial sales: DISABLED until Founder activation"
      );

      console.log(
        "Continuous playout: DISABLED until certified worker pass"
      );
    }
  );

  return server;
}

function runSelfTest() {
  const data = readData();
  const errors = [];

  if (
    data.viewerAccessModel !==
    "FREE_TO_VIEW"
  ) {
    errors.push(
      "viewerAccessModel must remain FREE_TO_VIEW."
    );
  }

  if (
    !Array.isArray(data.rateCards) ||
    data.rateCards.length < 1
  ) {
    errors.push(
      "At least one rate card is required."
    );
  }

  if (
    !Array.isArray(
      data.productionServices
    ) ||
    data.productionServices.length < 1
  ) {
    errors.push(
      "At least one production service is required."
    );
  }

  if (
    data.commercialSalesEnabled ||
    data.publicOrderIntakeEnabled ||
    data.playoutEnabled
  ) {
    errors.push(
      "Foundation safety flags must remain disabled in ANPE-01."
    );
  }

  if (errors.length) {
    console.error(
      "ANPE SELF-TEST FAILED"
    );

    errors.forEach(
      (error) =>
        console.error(`- ${error}`)
    );

    process.exitCode = 1;
    return;
  }

  console.log(
    "ANPE SELF-TEST PASSED"
  );

  console.log(
    `Rate cards: ${data.rateCards.length}`
  );

  console.log(
    `Production services: ${data.productionServices.length}`
  );

  console.log(
    `Viewer access model: ${data.viewerAccessModel}`
  );

  console.log(
    `Commercial sales enabled: ${data.commercialSalesEnabled}`
  );

  console.log(
    `Public order intake enabled: ${data.publicOrderIntakeEnabled}`
  );

  console.log(
    `Playout enabled: ${data.playoutEnabled}`
  );
}

if (require.main === module) {
  if (
    process.argv.includes(
      "--self-test"
    )
  ) {
    runSelfTest();
  } else {
    startServer();
  }
}

module.exports = {
  defaultData,
  normalizeData,
  normalizeCampaign,
  normalizeOffer,
  readData,
  writeData,
  runSelfTest,
  startServer,
};
