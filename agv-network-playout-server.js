"use strict";

require("dotenv").config();

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// PASS ANPE-02B1 — EXISTING AGV OWNER SESSION
// Reuse the signed SERVER 8792 Owner/Admin session. No second login.

const HOST = String(
  process.env.AGV_ANPE_HOST || "127.0.0.1"
).trim();

const PORT = Number(
  process.env.AGV_ANPE_PORT || 8802
);

const CONFIGURED_DATA_FILE = String(
  process.env.AGV_ANPE_DATA_FILE ||
    ""
).trim();

const DATA_FILE =
  CONFIGURED_DATA_FILE
    ? path.resolve(
        __dirname,
        CONFIGURED_DATA_FILE
      )
    : path.join(
        __dirname,
        "agv-network-playout.json"
      );

const ADMIN_TOKEN = String(
  process.env.AGV_ANPE_ADMIN_TOKEN || ""
).trim();

// PASS ANPE-02B2B — SERVER 8787 SUPER ADMIN BRIDGE
// Validate the existing SERVER 8787 session through /api/auth/me.
// ANPE does not copy the 8787 JWT secret, passwords, or user database.
const AGV_AUTH_BASE_URL = String(
  process.env.AGV_AUTH_BASE_URL ||
    "http://127.0.0.1:8787"
)
  .trim()
  .replace(/\/+$/, "");

const AGV_AUTH_TIMEOUT_MS = Math.max(
  1000,
  Number(
    process.env.AGV_AUTH_TIMEOUT_MS ||
      5000
  ) || 5000
);

const AGV_SESSION_SECRET = String(
  process.env.AGV_SESSION_SECRET || ""
).trim();

const AGV_SUPER_ADMIN_EMAILS = new Set(
  String(process.env.AGV_SUPER_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

const APPROVED_AGV_ADMIN_ROLES = new Set([
  "owner",
  "admin",
  "super_admin",
  "superadmin",
]);

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

// PASS ANPE-02C3B — COMMERCIAL RELATIONSHIP SCHEMA
// Schema only. Sales, billing, and playout remain disabled.
const CONTRACT_STATUSES = new Set([
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "SIGNED",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "VOID",
]);

const SCHEDULE_PLACEMENT_STATUSES = new Set([
  "DRAFT",
  "HOLD",
  "CONFIRMED",
  "SCHEDULED",
  "AIRED",
  "MISSED",
  "CANCELLED",
]);

const INVOICE_STATUSES = new Set([
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "PAST_DUE",
  "VOID",
  "REFUNDED",
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
    schemaVersion: 2,

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

    contracts: [],

    schedulePlacements: [],

    invoices: [],

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

    contactPhone: cleanText(
      source.contactPhone ||
        source.buyerPhone,
      80
    ),

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

    contractId: cleanText(
      source.contractId,
      160
    ),

    schedulePlacementIds:
      Array.isArray(
        source.schedulePlacementIds
      )
        ? source.schedulePlacementIds
            .map((value) =>
              cleanText(value, 160)
            )
            .filter(Boolean)
        : [],

    invoiceId: cleanText(
      source.invoiceId,
      160
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

    createdBy: cleanText(
      source.createdBy,
      254
    ),

    updatedBy: cleanText(
      source.updatedBy,
      254
    ),

    createdAt:
      nullableIso(source.createdAt) ||
      nowIso(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function normalizeContract(item, index) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  const requestedStatus = cleanText(
    source.status || "DRAFT",
    60
  ).toUpperCase();

  return {
    id: cleanId(
      source.id,
      `contract-${index + 1}`
    ),

    campaignId: cleanText(
      source.campaignId,
      160
    ),

    contractNumber: cleanText(
      source.contractNumber,
      120
    ),

    title: cleanText(
      source.title ||
        `Commercial Contract ${index + 1}`,
      180
    ),

    organization: cleanText(
      source.organization,
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

    contactPhone: cleanText(
      source.contactPhone,
      80
    ),

    status:
      CONTRACT_STATUSES.has(
        requestedStatus
      )
        ? requestedStatus
        : "DRAFT",

    effectiveAt:
      nullableIso(source.effectiveAt),

    expiresAt:
      nullableIso(source.expiresAt),

    signedAt:
      nullableIso(source.signedAt),

    totalAmountCents:
      nonnegativeInteger(
        source.totalAmountCents
      ),

    currency: cleanText(
      source.currency || "USD",
      10
    ).toUpperCase(),

    terms: cleanText(
      source.terms,
      10000
    ),

    notes: cleanText(
      source.notes,
      2000
    ),

    createdBy: cleanText(
      source.createdBy,
      254
    ),

    updatedBy: cleanText(
      source.updatedBy,
      254
    ),

    createdAt:
      nullableIso(source.createdAt) ||
      nowIso(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function normalizeSchedulePlacement(
  item,
  index
) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  const requestedStatus = cleanText(
    source.status || "DRAFT",
    60
  ).toUpperCase();

  return {
    id: cleanId(
      source.id,
      `schedule-placement-${index + 1}`
    ),

    campaignId: cleanText(
      source.campaignId,
      160
    ),

    contractId: cleanText(
      source.contractId,
      160
    ),

    stationId: cleanId(
      source.stationId,
      "station"
    ),

    programId: cleanId(
      source.programId,
      "program"
    ),

    offerId: cleanId(
      source.offerId,
      "offer"
    ),

    placementType: cleanText(
      source.placementType || "AIRTIME_SPOT",
      80
    ).toUpperCase(),

    scheduledStartAt:
      nullableIso(
        source.scheduledStartAt ||
          source.startAt
      ),

    scheduledEndAt:
      nullableIso(
        source.scheduledEndAt ||
          source.endAt
      ),

    durationSeconds:
      nonnegativeInteger(
        source.durationSeconds
      ),

    quantity: Math.max(
      1,
      nonnegativeInteger(
        source.quantity || 1
      )
    ),

    sequence:
      nonnegativeInteger(
        source.sequence
      ),

    status:
      SCHEDULE_PLACEMENT_STATUSES.has(
        requestedStatus
      )
        ? requestedStatus
        : "DRAFT",

    creativeAssetId: cleanText(
      source.creativeAssetId,
      160
    ),

    notes: cleanText(
      source.notes,
      2000
    ),

    createdBy: cleanText(
      source.createdBy,
      254
    ),

    updatedBy: cleanText(
      source.updatedBy,
      254
    ),

    createdAt:
      nullableIso(source.createdAt) ||
      nowIso(),

    updatedAt:
      nullableIso(source.updatedAt) ||
      nowIso(),
  };
}

function normalizePaymentRecord(
  item,
  index,
  invoiceId,
  invoiceCurrency
) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  return {
    id: cleanId(
      source.id,
      "payment-record-" + (index + 1)
    ),

    invoiceId: cleanText(
      source.invoiceId ||
        invoiceId,
      160
    ),

    status: "RECORDED",

    amountCents:
      nonnegativeInteger(
        source.amountCents
      ),

    currency: cleanText(
      source.currency ||
        invoiceCurrency ||
        "USD",
      10
    ).toUpperCase(),

    paymentMethod: cleanText(
      source.paymentMethod ||
        "OTHER",
      60
    ).toUpperCase(),

    paymentProvider: cleanText(
      source.paymentProvider ||
        "MANUAL",
      80
    ).toUpperCase(),

    paymentReference: cleanText(
      source.paymentReference,
      200
    ),

    externalTransactionId:
      cleanText(
        source.externalTransactionId,
        200
      ),

    receivedAt:
      nullableIso(source.receivedAt),

    recordedAt:
      nullableIso(source.recordedAt) ||
      nowIso(),

    recordedBy: cleanText(
      source.recordedBy,
      254
    ),

    evidenceNote: cleanText(
      source.evidenceNote,
      2000
    ),

    attestation:
      source.attestation === true,
  };
}

function normalizeInvoice(item, index) {
  const source =
    item && typeof item === "object"
      ? item
      : {};

  const requestedStatus = cleanText(
    source.status || "DRAFT",
    60
  ).toUpperCase();

  const subtotalCents =
    nonnegativeInteger(
      source.subtotalCents
    );

  const taxCents =
    nonnegativeInteger(
      source.taxCents
    );

  const totalCents =
    nonnegativeInteger(
      source.totalCents ||
        subtotalCents + taxCents
    );

  const paymentRecordSource =
    Array.isArray(
      source.paymentRecords
    )
      ? source.paymentRecords
      : [];

  const invoiceIdForRecords =
    cleanText(
      source.id,
      160
    );

  const invoiceCurrency =
    cleanText(
      source.currency || "USD",
      10
    ).toUpperCase();

  const paymentRecords =
    paymentRecordSource.map(
      (paymentRecord, paymentIndex) =>
        normalizePaymentRecord(
          paymentRecord,
          paymentIndex,
          invoiceIdForRecords,
          invoiceCurrency
        )
    );

  const recordedPaymentTotalCents =
    paymentRecords.reduce(
      (sum, paymentRecord) =>
        sum +
        nonnegativeInteger(
          paymentRecord.amountCents
        ),
      0
    );

  const amountPaidCents =
    paymentRecords.length > 0
      ? Math.min(
          totalCents,
          recordedPaymentTotalCents
        )
      : nonnegativeInteger(
          source.amountPaidCents
        );

  return {
    id: cleanId(
      source.id,
      `invoice-${index + 1}`
    ),

    campaignId: cleanText(
      source.campaignId,
      160
    ),

    contractId: cleanText(
      source.contractId,
      160
    ),

    invoiceNumber: cleanText(
      source.invoiceNumber,
      120
    ),

    status:
      INVOICE_STATUSES.has(
        requestedStatus
      )
        ? requestedStatus
        : "DRAFT",

    subtotalCents,
    taxCents,
    totalCents,
    amountPaidCents,

    balanceDueCents:
      paymentRecords.length > 0 ||
      source.balanceDueCents ===
      undefined
        ? Math.max(
            0,
            totalCents -
              amountPaidCents
          )
        : nonnegativeInteger(
            source.balanceDueCents
          ),

    currency: cleanText(
      source.currency || "USD",
      10
    ).toUpperCase(),

    issuedAt:
      nullableIso(source.issuedAt),

    dueAt:
      nullableIso(source.dueAt),

    paidAt:
      nullableIso(source.paidAt),

    paymentRecords,

    lastPaymentAt:
      nullableIso(
        source.lastPaymentAt
      ) ||
      (paymentRecords.length > 0
        ? paymentRecords[0]
            .receivedAt ||
          paymentRecords[0]
            .recordedAt
        : ""),

    notes: cleanText(
      source.notes,
      2000
    ),

    createdBy: cleanText(
      source.createdBy,
      254
    ),

    updatedBy: cleanText(
      source.updatedBy,
      254
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

  const contractSource =
    Array.isArray(source.contracts)
      ? source.contracts
      : [];

  const schedulePlacementSource =
    Array.isArray(
      source.schedulePlacements
    )
      ? source.schedulePlacements
      : [];

  const invoiceSource =
    Array.isArray(source.invoices)
      ? source.invoices
      : [];

  return {
    schemaVersion: 2,

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

    contracts:
      contractSource.map(
        normalizeContract
      ),

    schedulePlacements:
      schedulePlacementSource.map(
        normalizeSchedulePlacement
      ),

    invoices:
      invoiceSource.map(
        normalizeInvoice
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

function getBearerToken(req) {
  const authorization = cleanText(
    req.headers.authorization,
    4000
  );

  return authorization
    .toLowerCase()
    .startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function verifyOwnerAdminSession(
  supplied
) {
  const configured =
    Boolean(AGV_SESSION_SECRET) &&
    AGV_SUPER_ADMIN_EMAILS.size > 0;

  if (!configured) {
    return {
      ok: false,
      configured: false,
    };
  }

  try {
    const claims = jwt.verify(
      supplied,
      AGV_SESSION_SECRET,
      {
        issuer: "agv-subscription-server",
        audience: "agv-platform",
      }
    );

    const email = cleanText(
      claims?.email,
      254
    ).toLowerCase();

    const role = cleanText(
      claims?.role,
      80
    ).toLowerCase();

    if (
      claims?.tokenType !== "agv_host_session" ||
      !email ||
      !APPROVED_AGV_ADMIN_ROLES.has(role) ||
      !AGV_SUPER_ADMIN_EMAILS.has(email)
    ) {
      return {
        ok: false,
        configured: true,
        status: 403,
        error:
          "AGV Founder or Super Admin authorization is required.",
      };
    }

    return {
      ok: true,
      actor: email,
      email,
      role,
      source: "agv-subscription-server",
    };
  }
  catch {
    return {
      ok: false,
      configured: true,
      status: 401,
    };
  }
}

function validate8787Superadmin(
  supplied
) {
  return new Promise((resolve) => {
    if (!AGV_AUTH_BASE_URL) {
      resolve({
        ok: false,
        configured: false,
      });

      return;
    }

    let endpoint;

    try {
      endpoint = new URL(
        `${AGV_AUTH_BASE_URL}/api/auth/me`
      );
    }
    catch {
      resolve({
        ok: false,
        configured: false,
        unavailable: true,
        error:
          "SERVER 8787 authentication URL is invalid.",
      });

      return;
    }

    const transport =
      endpoint.protocol === "https:"
        ? https
        : http;

    const request =
      transport.request(
        endpoint,
        {
          method: "GET",

          headers: {
            Accept:
              "application/json",

            Authorization:
              `Bearer ${supplied}`,
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;

          response.on(
            "data",
            (chunk) => {
              size += chunk.length;

              if (size <= 100000) {
                chunks.push(chunk);
              }
            }
          );

          response.on(
            "end",
            () => {
              const status = Number(
                response.statusCode ||
                500
              );

              let payload = {};

              try {
                payload = JSON.parse(
                  Buffer.concat(chunks)
                    .toString("utf8")
                );
              }
              catch {
                payload = {};
              }

              if (
                status === 200 &&
                payload?.ok === true &&
                payload?.user
              ) {
                if (
                  payload.user.globalRole !==
                  "superadmin"
                ) {
                  resolve({
                    ok: false,
                    configured: true,
                    status: 403,
                    error:
                      "SERVER 8787 Super Admin authorization is required.",
                  });

                  return;
                }

                const actor = cleanText(
                  payload.user.username ||
                    payload.user.displayName ||
                    "AGV_SUPERADMIN",
                  254
                );

                resolve({
                  ok: true,
                  actor,
                  source: "agv-server-8787",
                  user: payload.user,
                });

                return;
              }

              if (status === 403) {
                resolve({
                  ok: false,
                  configured: true,
                  status: 403,
                  error:
                    "SERVER 8787 Super Admin authorization is required.",
                });

                return;
              }

              if (status === 401) {
                resolve({
                  ok: false,
                  configured: true,
                  status: 401,
                });

                return;
              }

              resolve({
                ok: false,
                configured: true,
                unavailable: true,
                error:
                  `SERVER 8787 authentication returned HTTP ${status}.`,
              });
            }
          );
        }
      );

    request.setTimeout(
      AGV_AUTH_TIMEOUT_MS,
      () => {
        request.destroy(
          new Error(
            "SERVER 8787 authentication timed out."
          )
        );
      }
    );

    request.on(
      "error",
      (error) => {
        resolve({
          ok: false,
          configured: true,
          unavailable: true,
          error:
            error.message ||
            "SERVER 8787 authentication is unavailable.",
        });
      }
    );

    request.end();
  });
}

function validateEmergencyToken(
  supplied
) {
  if (!ADMIN_TOKEN) {
    return {
      ok: false,
      configured: false,
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

  return matches
    ? {
        ok: true,
        actor: "ANPE_EMERGENCY_ADMIN",
        source: "anpe-emergency-token",
      }
    : {
        ok: false,
        configured: true,
      };
}

async function authorizeAdmin(req) {
  const supplied =
    getBearerToken(req);

  if (!supplied) {
    return {
      ok: false,
      status: 401,
      error:
        "A verified AGV Founder or Super Admin session is required.",
    };
  }

  const ownerSession =
    verifyOwnerAdminSession(
      supplied
    );

  if (ownerSession.ok) {
    return ownerSession;
  }

  const server8787 =
    await validate8787Superadmin(
      supplied
    );

  if (server8787.ok) {
    return server8787;
  }

  const emergencyToken =
    validateEmergencyToken(
      supplied
    );

  if (emergencyToken.ok) {
    return emergencyToken;
  }

  if (
    ownerSession.status === 403 ||
    server8787.status === 403
  ) {
    return {
      ok: false,
      status: 403,
      error:
        "AGV Founder or Super Admin authorization is required.",
    };
  }

  if (server8787.unavailable) {
    return {
      ok: false,
      status: 503,
      error:
        "SERVER 8787 administrative authentication is temporarily unavailable.",
    };
  }

  return {
    ok: false,
    status: 401,
    error:
      "Invalid or expired AGV administrative session.",
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
        !AGV_AUTH_BASE_URL &&
        !(
          AGV_SESSION_SECRET &&
          AGV_SUPER_ADMIN_EMAILS.size
        ) &&
        !ADMIN_TOKEN,

      adminAuthentication: {
        server8787Bridge:
          Boolean(
            AGV_AUTH_BASE_URL
          ),

        agvOwnerSession:
          Boolean(
            AGV_SESSION_SECRET &&
            AGV_SUPER_ADMIN_EMAILS.size
          ),

        emergencyToken:
          Boolean(ADMIN_TOKEN),
      },

      dataFile:
        DATA_FILE,

      rateCardCount:
        data.rateCards.length,

      productionServiceCount:
        data.productionServices.length,

      campaignCount:
        data.campaigns.length,

      contractCount:
        data.contracts.length,

      schedulePlacementCount:
        data.schedulePlacements.length,

      invoiceCount:
        data.invoices.length,

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
      await authorizeAdmin(req);

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

            createdBy:
              auth.actor,

            updatedBy:
              auth.actor,

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

    // PASS ANPE-02D1 — ADMIN CONTRACT WORKFLOW ROUTES
    // Administrative foundation only. No public sale or billing execution.
    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/commercial/contracts"
    ) {
      const data = readData();

      const campaignId = cleanText(
        url.searchParams.get("campaignId"),
        160
      );

      const contracts = campaignId
        ? data.contracts.filter(
            (item) =>
              item.campaignId ===
              campaignId
          )
        : data.contracts;

      sendJson(res, 200, {
        ok: true,
        contracts,
        count: contracts.length,
      });

      return;
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/commercial/contracts"
    ) {
      const body =
        await readJsonBody(req);

      const campaignId = cleanText(
        body.campaignId,
        160
      );

      if (!campaignId) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A campaignId is required.",
        });

        return;
      }

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

      const existingContract =
        data.contracts.find(
          (item) =>
            item.campaignId ===
              campaignId &&
            item.status !== "VOID" &&
            item.status !==
              "CANCELLED"
        );

      if (existingContract) {
        sendJson(res, 409, {
          ok: false,
          error:
            "This campaign already has an active contract record.",
          contract:
            existingContract,
        });

        return;
      }

      const timestamp = nowIso();

      const contract =
        normalizeContract(
          {
            ...body,

            id:
              body.id ||
              `contract-${crypto.randomUUID()}`,

            campaignId:
              campaign.id,

            organization:
              body.organization ||
              campaign.organization,

            buyerName:
              body.buyerName ||
              campaign.buyerName,

            buyerEmail:
              body.buyerEmail ||
              campaign.buyerEmail,

            contactPhone:
              body.contactPhone ||
              campaign.contactPhone,

            status: "DRAFT",

            createdBy:
              auth.actor,

            updatedBy:
              auth.actor,

            createdAt:
              timestamp,

            updatedAt:
              timestamp,
          },

          data.contracts.length
        );

      data.contracts.unshift(
        contract
      );

      campaign.contractId =
        contract.id;

      campaign.updatedBy =
        auth.actor;

      campaign.updatedAt =
        timestamp;

      addAudit(
        data,
        "CONTRACT_CREATED",
        auth.actor,
        `${contract.id}: ${campaign.id}`
      );

      const saved =
        writeData(data);

      sendJson(res, 201, {
        ok: true,

        contract:
          saved.contracts.find(
            (item) =>
              item.id ===
              contract.id
          ),

        campaign:
          saved.campaigns.find(
            (item) =>
              item.id ===
              campaign.id
          ),
      });

      return;
    }

    const contractStatusMatch =
      pathname.match(
        /^\/api\/admin\/commercial\/contracts\/([^/]+)\/status$/
      );

    if (
      req.method === "PATCH" &&
      contractStatusMatch
    ) {
      const body =
        await readJsonBody(req);

      const requestedStatus =
        cleanText(
          body.status,
          60
        ).toUpperCase();

      if (
        !CONTRACT_STATUSES.has(
          requestedStatus
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown contract status.",

          allowedStatuses:
            Array.from(
              CONTRACT_STATUSES
            ),
        });

        return;
      }

      const contractId =
        cleanId(
          decodeURIComponent(
            contractStatusMatch[1]
          ),
          "contract"
        );

      const data = readData();

      const contract =
        data.contracts.find(
          (item) =>
            item.id === contractId
        );

      if (!contract) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Contract was not found.",
        });

        return;
      }

      const previousStatus =
        contract.status;

      const timestamp = nowIso();

      contract.status =
        requestedStatus;

      if (
        requestedStatus === "SIGNED" &&
        !contract.signedAt
      ) {
        contract.signedAt =
          timestamp;
      }

      contract.updatedBy =
        auth.actor;

      contract.updatedAt =
        timestamp;

      const campaign =
        data.campaigns.find(
          (item) =>
            item.id ===
            contract.campaignId
        );

      if (campaign) {
        campaign.contractId =
          contract.id;

        campaign.updatedBy =
          auth.actor;

        campaign.updatedAt =
          timestamp;
      }

      addAudit(
        data,
        "CONTRACT_STATUS_UPDATED",
        auth.actor,
        `${contract.id}: ${previousStatus} -> ${requestedStatus}`
      );

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,

        contract:
          saved.contracts.find(
            (item) =>
              item.id ===
              contract.id
          ),
      });

      return;
    }

    // PASS ANPE-02E1B — ADMIN SCHEDULE-PLACEMENT WORKFLOW ROUTES
    // Administrative scheduling only. Playout remains disabled.
    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/commercial/schedule-placements"
    ) {
      const data = readData();

      const campaignId = cleanText(
        url.searchParams.get("campaignId"),
        160
      );

      const contractId = cleanText(
        url.searchParams.get("contractId"),
        160
      );

      const stationId = cleanText(
        url.searchParams.get("stationId"),
        160
      );

      const statusFilter = cleanText(
        url.searchParams.get("status"),
        60
      ).toUpperCase();

      const schedulePlacements =
        data.schedulePlacements.filter(
          (item) =>
            (!campaignId ||
              item.campaignId ===
                campaignId) &&
            (!contractId ||
              item.contractId ===
                contractId) &&
            (!stationId ||
              item.stationId ===
                stationId) &&
            (!statusFilter ||
              item.status ===
                statusFilter)
        );

      sendJson(res, 200, {
        ok: true,
        schedulePlacements,
        count:
          schedulePlacements.length,
      });

      return;
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/commercial/schedule-placements"
    ) {
      const body =
        await readJsonBody(req);

      const campaignId = cleanText(
        body.campaignId,
        160
      );

      const contractId = cleanText(
        body.contractId,
        160
      );

      if (!campaignId) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A campaignId is required.",
        });

        return;
      }

      if (!contractId) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A contractId is required.",
        });

        return;
      }

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

      const contract =
        data.contracts.find(
          (item) =>
            item.id === contractId
        );

      if (!contract) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Contract was not found.",
        });

        return;
      }

      if (
        contract.campaignId !==
        campaign.id
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The contract does not belong to this campaign.",
        });

        return;
      }

      if (
        contract.status !== "SIGNED" &&
        contract.status !==
          "ACTIVE"
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The contract must be SIGNED or ACTIVE before airtime can be scheduled.",
          contractStatus:
            contract.status,
        });

        return;
      }

      const scheduledStartAt =
        nullableIso(
          body.scheduledStartAt ||
            body.startAt
        );

      const scheduledEndAt =
        nullableIso(
          body.scheduledEndAt ||
            body.endAt
        );

      if (
        !scheduledStartAt ||
        !scheduledEndAt
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Valid scheduledStartAt and scheduledEndAt values are required.",
        });

        return;
      }

      const startMs =
        Date.parse(
          scheduledStartAt
        );

      const endMs =
        Date.parse(
          scheduledEndAt
        );

      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "The scheduled end time must be after the scheduled start time.",
        });

        return;
      }

      const stationId = cleanId(
        body.stationId ||
          campaign.stationId,
        "station"
      );

      const conflictingPlacement =
        data.schedulePlacements.find(
          (item) => {
            if (
              item.stationId !==
                stationId ||
              item.status === "CANCELLED" ||
              item.status === "MISSED" ||
              !item.scheduledStartAt ||
              !item.scheduledEndAt
            ) {
              return false;
            }

            const existingStart =
              Date.parse(
                item.scheduledStartAt
              );

            const existingEnd =
              Date.parse(
                item.scheduledEndAt
              );

            return (
              Number.isFinite(
                existingStart
              ) &&
              Number.isFinite(
                existingEnd
              ) &&
              startMs < existingEnd &&
              endMs > existingStart
            );
          }
        );

      if (conflictingPlacement) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The requested airtime overlaps an existing placement on this station.",
          conflictingPlacement,
        });

        return;
      }

      const timestamp = nowIso();

      const placement =
        normalizeSchedulePlacement(
          {
            ...body,

            id:
              body.id ||
              `schedule-placement-${crypto.randomUUID()}`,

            campaignId:
              campaign.id,

            contractId:
              contract.id,

            stationId,

            programId:
              body.programId ||
              campaign.programId,

            offerId:
              body.offerId ||
              campaign.offerId,

            placementType:
              body.placementType ||
              campaign.offerType ||
              "AIRTIME_SPOT",

            scheduledStartAt,
            scheduledEndAt,

            durationSeconds:
              Math.max(
                1,
                Math.round(
                  (endMs - startMs) /
                    1000
                )
              ),

            status: "DRAFT",

            createdBy:
              auth.actor,

            updatedBy:
              auth.actor,

            createdAt:
              timestamp,

            updatedAt:
              timestamp,
          },

          data.schedulePlacements.length
        );

      data.schedulePlacements.unshift(
        placement
      );

      campaign.schedulePlacementIds =
        Array.from(
          new Set([
            placement.id,
            ...campaign.schedulePlacementIds,
          ])
        );

      campaign.updatedBy =
        auth.actor;

      campaign.updatedAt =
        timestamp;

      addAudit(
        data,
        "SCHEDULE_PLACEMENT_CREATED",
        auth.actor,
        `${placement.id}: ${campaign.id}: ${stationId}`
      );

      const saved =
        writeData(data);

      sendJson(res, 201, {
        ok: true,

        schedulePlacement:
          saved.schedulePlacements.find(
            (item) =>
              item.id ===
              placement.id
          ),

        campaign:
          saved.campaigns.find(
            (item) =>
              item.id ===
              campaign.id
          ),
      });

      return;
    }

    const scheduleStatusMatch =
      pathname.match(
        /^\/api\/admin\/commercial\/schedule-placements\/([^/]+)\/status$/
      );

    if (
      req.method === "PATCH" &&
      scheduleStatusMatch
    ) {
      const body =
        await readJsonBody(req);

      const requestedStatus =
        cleanText(
          body.status,
          60
        ).toUpperCase();

      if (
        !SCHEDULE_PLACEMENT_STATUSES.has(
          requestedStatus
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown schedule-placement status.",

          allowedStatuses:
            Array.from(
              SCHEDULE_PLACEMENT_STATUSES
            ),
        });

        return;
      }

      const placementId =
        cleanId(
          decodeURIComponent(
            scheduleStatusMatch[1]
          ),
          "schedule-placement"
        );

      const data = readData();

      const placement =
        data.schedulePlacements.find(
          (item) =>
            item.id === placementId
        );

      if (!placement) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Schedule placement was not found.",
        });

        return;
      }

      if (
        requestedStatus === "AIRED" &&
        data.playoutEnabled !== true
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "AIRED status is unavailable until certified playout and proof-of-play activation.",
        });

        return;
      }

      const contract =
        data.contracts.find(
          (item) =>
            item.id ===
            placement.contractId
        );

      if (
        (requestedStatus ===
          "CONFIRMED" ||
          requestedStatus ===
          "SCHEDULED") &&
        (!contract ||
          (contract.status !== "SIGNED" &&
            contract.status !==
              "ACTIVE"))
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "A SIGNED or ACTIVE contract is required before confirming or scheduling airtime.",
        });

        return;
      }

      if (
        requestedStatus ===
          "CONFIRMED" ||
        requestedStatus ===
          "SCHEDULED"
      ) {
        const startMs =
          Date.parse(
            placement.scheduledStartAt
          );

        const endMs =
          Date.parse(
            placement.scheduledEndAt
          );

        const conflict =
          data.schedulePlacements.find(
            (item) => {
              if (
                item.id ===
                  placement.id ||
                item.stationId !==
                  placement.stationId ||
                item.status === "CANCELLED" ||
                item.status === "MISSED" ||
                !item.scheduledStartAt ||
                !item.scheduledEndAt
              ) {
                return false;
              }

              const existingStart =
                Date.parse(
                  item.scheduledStartAt
                );

              const existingEnd =
                Date.parse(
                  item.scheduledEndAt
                );

              return (
                Number.isFinite(
                  startMs
                ) &&
                Number.isFinite(
                  endMs
                ) &&
                Number.isFinite(
                  existingStart
                ) &&
                Number.isFinite(
                  existingEnd
                ) &&
                startMs < existingEnd &&
                endMs > existingStart
              );
            }
          );

        if (conflict) {
          sendJson(res, 409, {
            ok: false,
            error:
              "This airtime conflicts with another placement on the station.",
            conflictingPlacement:
              conflict,
          });

          return;
        }
      }

      const previousStatus =
        placement.status;

      placement.status =
        requestedStatus;

      placement.updatedBy =
        auth.actor;

      placement.updatedAt =
        nowIso();

      addAudit(
        data,
        "SCHEDULE_PLACEMENT_STATUS_UPDATED",
        auth.actor,
        `${placement.id}: ${previousStatus} -> ${requestedStatus}`
      );

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,

        schedulePlacement:
          saved.schedulePlacements.find(
            (item) =>
              item.id ===
              placement.id
          ),
      });

      return;
    }

    // PASS ANPE-02F1B — ADMIN INVOICE WORKFLOW ROUTES
    // Administrative invoicing only. No payment processing or billing execution.
    if (
      req.method === "GET" &&
      pathname ===
        "/api/admin/commercial/invoices"
    ) {
      const data = readData();

      const campaignId = cleanText(
        url.searchParams.get("campaignId"),
        160
      );

      const contractId = cleanText(
        url.searchParams.get("contractId"),
        160
      );

      const statusFilter = cleanText(
        url.searchParams.get("status"),
        60
      ).toUpperCase();

      const invoices =
        data.invoices.filter(
          (item) =>
            (!campaignId ||
              item.campaignId ===
                campaignId) &&
            (!contractId ||
              item.contractId ===
                contractId) &&
            (!statusFilter ||
              item.status ===
                statusFilter)
        );

      sendJson(res, 200, {
        ok: true,
        invoices,
        count: invoices.length,
      });

      return;
    }

    if (
      req.method === "POST" &&
      pathname ===
        "/api/admin/commercial/invoices"
    ) {
      const body =
        await readJsonBody(req);

      const campaignId = cleanText(
        body.campaignId,
        160
      );

      const contractId = cleanText(
        body.contractId,
        160
      );

      if (!campaignId) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A campaignId is required.",
        });

        return;
      }

      if (!contractId) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A contractId is required.",
        });

        return;
      }

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

      const contract =
        data.contracts.find(
          (item) =>
            item.id === contractId
        );

      if (!contract) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Contract was not found.",
        });

        return;
      }

      if (
        contract.campaignId !==
        campaign.id
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The contract does not belong to this campaign.",
        });

        return;
      }

      if (
        contract.status !== "SIGNED" &&
        contract.status !==
          "ACTIVE"
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The contract must be SIGNED or ACTIVE before an invoice can be created.",
          contractStatus:
            contract.status,
        });

        return;
      }

      const existingInvoice =
        data.invoices.find(
          (item) =>
            item.campaignId ===
              campaign.id &&
            item.contractId ===
              contract.id &&
            item.status !== "VOID" &&
            item.status !==
              "REFUNDED"
        );

      if (existingInvoice) {
        sendJson(res, 409, {
          ok: false,
          error:
            "This campaign and contract already have an active invoice.",
          invoice:
            existingInvoice,
        });

        return;
      }

      const invoiceNumber =
        cleanText(
          body.invoiceNumber ||
            `ANPE-${Date.now()}-${data.invoices.length + 1}`,
          120
        );

      const duplicateNumber =
        data.invoices.find(
          (item) =>
            item.invoiceNumber &&
            item.invoiceNumber.toLowerCase() ===
              invoiceNumber.toLowerCase()
        );

      if (duplicateNumber) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The invoice number is already in use.",
          invoice:
            duplicateNumber,
        });

        return;
      }

      const subtotalSource =
        body.subtotalCents ===
        undefined
          ? campaign.quotedAmountCents
          : body.subtotalCents;

      const subtotalCents =
        Number(
          subtotalSource || 0
        );

      const taxCents =
        Number(
          body.taxCents || 0
        );

      const calculatedTotal =
        subtotalCents + taxCents;

      const totalCents =
        body.totalCents ===
        undefined
          ? calculatedTotal
          : Number(
              body.totalCents
            );

      if (
        !Number.isSafeInteger(
          subtotalCents
        ) ||
        !Number.isSafeInteger(
          taxCents
        ) ||
        !Number.isSafeInteger(
          totalCents
        ) ||
        subtotalCents < 0 ||
        taxCents < 0 ||
        totalCents < 0
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Invoice amounts must be nonnegative whole cents.",
        });

        return;
      }

      if (
        totalCents !==
        calculatedTotal
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Invoice totalCents must equal subtotalCents plus taxCents.",
        });

        return;
      }

      const requestedIssuedAt =
        cleanText(
          body.issuedAt,
          80
        );

      const requestedDueAt =
        cleanText(
          body.dueAt,
          80
        );

      const issuedAt =
        nullableIso(
          body.issuedAt
        );

      const dueAt =
        nullableIso(
          body.dueAt
        );

      if (
        requestedIssuedAt &&
        !issuedAt
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "issuedAt must contain a valid date and time.",
        });

        return;
      }

      if (
        requestedDueAt &&
        !dueAt
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "dueAt must contain a valid date and time.",
        });

        return;
      }

      if (
        issuedAt &&
        dueAt &&
        Date.parse(dueAt) <
          Date.parse(issuedAt)
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "The invoice due date cannot be before its issue date.",
        });

        return;
      }

      const timestamp = nowIso();

      const invoice =
        normalizeInvoice(
          {
            ...body,

            id:
              body.id ||
              `invoice-${crypto.randomUUID()}`,

            campaignId:
              campaign.id,

            contractId:
              contract.id,

            invoiceNumber,

            status: "DRAFT",

            subtotalCents,
            taxCents,
            totalCents,

            amountPaidCents: 0,

            balanceDueCents:
              totalCents,

            currency:
              body.currency ||
              campaign.currency ||
              "USD",

            issuedAt,
            dueAt,
            paidAt: null,

            createdBy:
              auth.actor,

            updatedBy:
              auth.actor,

            createdAt:
              timestamp,

            updatedAt:
              timestamp,
          },

          data.invoices.length
        );

      data.invoices.unshift(
        invoice
      );

      campaign.invoiceId =
        invoice.id;

      campaign.updatedBy =
        auth.actor;

      campaign.updatedAt =
        timestamp;

      addAudit(
        data,
        "INVOICE_CREATED",
        auth.actor,
        `${invoice.id}: ${campaign.id}: ${contract.id}`
      );

      const saved =
        writeData(data);

      sendJson(res, 201, {
        ok: true,

        invoice:
          saved.invoices.find(
            (item) =>
              item.id ===
              invoice.id
          ),

        campaign:
          saved.campaigns.find(
            (item) =>
              item.id ===
              campaign.id
          ),
      });

      return;
    }

    // PASS ANPE-02G1B — CONTROLLED PAYMENT-RECORDING ROUTES
    // Records external payment evidence only. No processor or checkout calls.
    const invoicePaymentsMatch =
      pathname.match(
        /^\/api\/admin\/commercial\/invoices\/([^/]+)\/payments$/
      );

    if (
      req.method === "GET" &&
      invoicePaymentsMatch
    ) {
      const invoiceId =
        cleanId(
          decodeURIComponent(
            invoicePaymentsMatch[1]
          ),
          "invoice"
        );

      const data = readData();

      const invoice =
        data.invoices.find(
          (item) =>
            item.id === invoiceId
        );

      if (!invoice) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Invoice was not found.",
        });

        return;
      }

      const paymentRecords =
        Array.isArray(
          invoice.paymentRecords
        )
          ? invoice.paymentRecords
          : [];

      sendJson(res, 200, {
        ok: true,
        invoiceId:
          invoice.id,
        paymentRecords,
        count:
          paymentRecords.length,
        amountPaidCents:
          invoice.amountPaidCents,
        balanceDueCents:
          invoice.balanceDueCents,
      });

      return;
    }

    if (
      req.method === "POST" &&
      invoicePaymentsMatch
    ) {
      const body =
        await readJsonBody(req);

      const invoiceId =
        cleanId(
          decodeURIComponent(
            invoicePaymentsMatch[1]
          ),
          "invoice"
        );

      const data = readData();

      const invoice =
        data.invoices.find(
          (item) =>
            item.id === invoiceId
        );

      if (!invoice) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Invoice was not found.",
        });

        return;
      }

      if (
        invoice.status !== "ISSUED" &&
        invoice.status !==
          "PARTIALLY_PAID" &&
        invoice.status !==
          "PAST_DUE"
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "Payments can only be recorded against an ISSUED, PARTIALLY_PAID, or PAST_DUE invoice.",
          invoiceStatus:
            invoice.status,
        });

        return;
      }

      const amountCents =
        Number(
          body.amountCents
        );

      if (
        !Number.isSafeInteger(
          amountCents
        ) ||
        amountCents <= 0
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Payment amountCents must be a positive whole-cent amount.",
        });

        return;
      }

      const currentBalance =
        nonnegativeInteger(
          invoice.balanceDueCents ===
          undefined
            ? invoice.totalCents -
                invoice.amountPaidCents
            : invoice.balanceDueCents
        );

      if (currentBalance <= 0) {
        sendJson(res, 409, {
          ok: false,
          error:
            "This invoice has no remaining balance.",
        });

        return;
      }

      if (
        amountCents >
        currentBalance
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The recorded payment cannot exceed the invoice balance.",
          balanceDueCents:
            currentBalance,
        });

        return;
      }

      const paymentReference =
        cleanText(
          body.paymentReference,
          200
        );

      if (!paymentReference) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A paymentReference is required.",
        });

        return;
      }

      const paymentMethod =
        cleanText(
          body.paymentMethod,
          60
        ).toUpperCase();

      const paymentProvider =
        cleanText(
          body.paymentProvider ||
            "MANUAL",
          80
        ).toUpperCase();

      const allowedMethods =
        new Set([
          "ACH",
          "WIRE",
          "CHECK",
          "CARD",
          "CASH",
          "OTHER",
        ]);

      const allowedProviders =
        new Set([
          "MANUAL",
          "STRIPE",
          "PAYPAL",
          "BANK",
          "OTHER",
        ]);

      if (
        !allowedMethods.has(
          paymentMethod
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown payment method.",
          allowedMethods:
            Array.from(
              allowedMethods
            ),
        });

        return;
      }

      if (
        !allowedProviders.has(
          paymentProvider
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown payment provider.",
          allowedProviders:
            Array.from(
              allowedProviders
            ),
        });

        return;
      }

      const externalTransactionId =
        cleanText(
          body.externalTransactionId ||
            body.transactionId ||
            body.paymentProviderId,
          200
        );

      if (
        paymentProvider !==
          "MANUAL" &&
        !externalTransactionId
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "An externalTransactionId is required for non-manual payment providers.",
        });

        return;
      }

      const evidenceNote =
        cleanText(
          body.evidenceNote,
          2000
        );

      if (evidenceNote.length < 8) {
        sendJson(res, 400, {
          ok: false,
          error:
            "A meaningful payment evidence note is required.",
        });

        return;
      }

      if (body.attestation !== true) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Payment evidence attestation must be accepted.",
        });

        return;
      }

      const requestedReceivedAt =
        cleanText(
          body.receivedAt,
          80
        );

      const receivedAt =
        requestedReceivedAt
          ? nullableIso(
              requestedReceivedAt
            )
          : nowIso();

      if (
        requestedReceivedAt &&
        !receivedAt
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "receivedAt must contain a valid date and time.",
        });

        return;
      }

      const currency =
        cleanText(
          body.currency ||
            invoice.currency ||
            "USD",
          10
        ).toUpperCase();

      if (
        currency !==
        invoice.currency
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "Payment currency must match the invoice currency.",
          invoiceCurrency:
            invoice.currency,
        });

        return;
      }

      const allPaymentRecords =
        data.invoices.flatMap(
          (item) =>
            Array.isArray(
              item.paymentRecords
            )
              ? item.paymentRecords
              : []
        );

      const duplicateReference =
        allPaymentRecords.find(
          (item) =>
            item.paymentReference &&
            item.paymentReference
              .toLowerCase() ===
            paymentReference
              .toLowerCase()
        );

      if (duplicateReference) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The payment reference has already been recorded.",
          paymentRecord:
            duplicateReference,
        });

        return;
      }

      if (externalTransactionId) {
        const duplicateTransaction =
          allPaymentRecords.find(
            (item) =>
              item.externalTransactionId &&
              item.externalTransactionId
                .toLowerCase() ===
              externalTransactionId
                .toLowerCase()
          );

        if (duplicateTransaction) {
          sendJson(res, 409, {
            ok: false,
            error:
              "The external transaction has already been recorded.",
            paymentRecord:
              duplicateTransaction,
          });

          return;
        }
      }

      const timestamp = nowIso();

      const paymentRecord =
        normalizePaymentRecord(
          {
            id:
              "payment-record-" +
              crypto.randomUUID(),

            invoiceId:
              invoice.id,

            amountCents,
            currency,
            paymentMethod,
            paymentProvider,
            paymentReference,
            externalTransactionId,
            receivedAt,

            recordedAt:
              timestamp,

            recordedBy:
              auth.actor,

            evidenceNote,
            attestation: true,
          },

          Array.isArray(
            invoice.paymentRecords
          )
            ? invoice.paymentRecords.length
            : 0,

          invoice.id,
          invoice.currency
        );

      invoice.paymentRecords =
        Array.isArray(
          invoice.paymentRecords
        )
          ? invoice.paymentRecords
          : [];

      invoice.paymentRecords.unshift(
        paymentRecord
      );

      invoice.amountPaidCents =
        nonnegativeInteger(
          invoice.amountPaidCents
        ) + amountCents;

      invoice.balanceDueCents =
        Math.max(
          0,
          nonnegativeInteger(
            invoice.totalCents
          ) -
          invoice.amountPaidCents
        );

      const previousStatus =
        invoice.status;

      if (
        invoice.balanceDueCents === 0
      ) {
        invoice.status = "PAID";
        invoice.paidAt =
          receivedAt;
      }
      else {
        invoice.status =
          "PARTIALLY_PAID";

        invoice.paidAt = "";
      }

      invoice.lastPaymentAt =
        receivedAt;

      invoice.updatedBy =
        auth.actor;

      invoice.updatedAt =
        timestamp;

      addAudit(
        data,
        "INVOICE_PAYMENT_RECORDED",
        auth.actor,
        invoice.id +
          ": " +
          amountCents +
          ": " +
          paymentReference
      );

      if (
        previousStatus !==
        invoice.status
      ) {
        addAudit(
          data,
          "INVOICE_STATUS_UPDATED",
          auth.actor,
          invoice.id +
            ": " +
            previousStatus +
            " -> " +
            invoice.status
        );
      }

      const saved =
        writeData(data);

      const savedInvoice =
        saved.invoices.find(
          (item) =>
            item.id === invoice.id
        );

      sendJson(res, 201, {
        ok: true,

        paymentRecord:
          savedInvoice
            ?.paymentRecords
            ?.find(
              (item) =>
                item.id ===
                paymentRecord.id
            ),

        invoice:
          savedInvoice,
      });

      return;
    }

    const invoiceStatusMatch =
      pathname.match(
        /^\/api\/admin\/commercial\/invoices\/([^/]+)\/status$/
      );

    if (
      req.method === "PATCH" &&
      invoiceStatusMatch
    ) {
      const body =
        await readJsonBody(req);

      const requestedStatus =
        cleanText(
          body.status,
          60
        ).toUpperCase();

      if (
        !INVOICE_STATUSES.has(
          requestedStatus
        )
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "Unknown invoice status.",

          allowedStatuses:
            Array.from(
              INVOICE_STATUSES
            ),
        });

        return;
      }

      const invoiceId =
        cleanId(
          decodeURIComponent(
            invoiceStatusMatch[1]
          ),
          "invoice"
        );

      const data = readData();

      const invoice =
        data.invoices.find(
          (item) =>
            item.id === invoiceId
        );

      if (!invoice) {
        sendJson(res, 404, {
          ok: false,
          error:
            "Invoice was not found.",
        });

        return;
      }

      if (
        requestedStatus ===
          "PARTIALLY_PAID" ||
        requestedStatus ===
          "PAID" ||
        requestedStatus ===
          "REFUNDED"
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "Payment-bearing invoice statuses require a separately certified payment-recording workflow.",
        });

        return;
      }

      if (
        requestedStatus ===
        invoice.status
      ) {
        sendJson(res, 200, {
          ok: true,
          invoice,
          unchanged: true,
        });

        return;
      }

      const transitionMap = {
        DRAFT: new Set(["ISSUED", "VOID"]),
        ISSUED: new Set(["PAST_DUE", "VOID"]),
        PAST_DUE: new Set(["VOID"]),
        PARTIALLY_PAID: new Set(),
        PAID: new Set(),
        VOID: new Set(),
        REFUNDED: new Set(),
      };

      const permitted =
        transitionMap[invoice.status] ||
        new Set();

      if (
        !permitted.has(
          requestedStatus
        )
      ) {
        sendJson(res, 409, {
          ok: false,
          error:
            "The requested invoice status transition is not permitted.",
          currentStatus:
            invoice.status,
          requestedStatus,
        });

        return;
      }

      const timestamp = nowIso();

      if (
        requestedStatus ===
          "ISSUED"
      ) {
        const issuedAt =
          invoice.issuedAt ||
          timestamp;

        if (!invoice.dueAt) {
          sendJson(res, 409, {
            ok: false,
            error:
              "A valid dueAt value is required before an invoice can be ISSUED.",
          });

          return;
        }

        if (
          Date.parse(
            invoice.dueAt
          ) <
          Date.parse(
            issuedAt
          )
        ) {
          sendJson(res, 400, {
            ok: false,
            error:
              "The invoice due date cannot be before its issue date.",
          });

          return;
        }

        invoice.issuedAt =
          issuedAt;
      }

      const previousStatus =
        invoice.status;

      invoice.status =
        requestedStatus;

      invoice.updatedBy =
        auth.actor;

      invoice.updatedAt =
        timestamp;

      addAudit(
        data,
        "INVOICE_STATUS_UPDATED",
        auth.actor,
        `${invoice.id}: ${previousStatus} -> ${requestedStatus}`
      );

      if (
        requestedStatus ===
          "ISSUED"
      ) {
        addAudit(
          data,
          "INVOICE_ISSUED",
          auth.actor,
          `${invoice.id}: ${invoice.invoiceNumber}`
        );
      }

      const saved =
        writeData(data);

      sendJson(res, 200, {
        ok: true,

        invoice:
          saved.invoices.find(
            (item) =>
              item.id ===
              invoice.id
          ),
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
        `SERVER 8787 Super Admin bridge: ${Boolean(
          AGV_AUTH_BASE_URL
        )}`
      );

      console.log(
        `SERVER 8792 Owner/Admin session auth: ${Boolean(
          AGV_SESSION_SECRET &&
          AGV_SUPER_ADMIN_EMAILS.size
        )}`
      );

      console.log(
        `ANPE emergency token configured: ${Boolean(
          ADMIN_TOKEN
        )}`
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

  if (!Array.isArray(data.contracts)) {
    errors.push(
      "contracts must be an array."
    );
  }

  if (
    !Array.isArray(
      data.schedulePlacements
    )
  ) {
    errors.push(
      "schedulePlacements must be an array."
    );
  }

  if (!Array.isArray(data.invoices)) {
    errors.push(
      "invoices must be an array."
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
    `Contracts: ${data.contracts.length}`
  );

  console.log(
    `Schedule placements: ${data.schedulePlacements.length}`
  );

  console.log(
    `Invoices: ${data.invoices.length}`
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
  normalizeContract,
  normalizeSchedulePlacement,
  normalizeInvoice,
  normalizeOffer,
  readData,
  writeData,
  runSelfTest,
  startServer,
};
