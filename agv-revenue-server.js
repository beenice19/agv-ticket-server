const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

let Pool = null;

try {
  Pool = require("pg").Pool;
} catch {
  Pool = null;
}

const PORT = Number(process.env.PORT || 8794);
const DATA_FILE = path.join(__dirname, "agv-revenue-reports.json");
const DATABASE_URL =
  process.env.DATABASE_URL || process.env.AGV_REVENUE_DATABASE_URL || "";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

let pool = null;
let databaseReady = false;
let databaseError = "";

if (DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });
}

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "revenue") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function cleanNumber(value, fallback = 0) {
  const number = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : fallback;
}

function cleanPlan(value) {
  const plan = String(value || "FREE").trim().toUpperCase();

  if (plan === "INTERNAL_TEST") return "CREATOR";

  if (["FREE", "CREATOR", "MINISTRY", "CONVENTION", "OWNER_ADMIN"].includes(plan)) {
    return plan;
  }

  return "FREE";
}

function calculateFees(body) {
  const grossRevenue = cleanNumber(body.grossRevenue ?? body.gross ?? body.revenue, 0);
  const refunds = cleanNumber(body.refunds ?? body.refundsIssued, 0);
  const netRevenue = Math.max(0, grossRevenue - refunds);
  const feeRate = 0.02;
  const agvFee = Number((netRevenue * feeRate).toFixed(2));

  return {
    grossRevenue,
    refunds,
    netRevenue,
    feeRate,
    agvFee,
  };
}

function isAdminRequest(req) {
  const configuredPin = cleanText(
    process.env.AGV_REVENUE_ADMIN_PIN || process.env.AGV_ADMIN_PIN || ""
  );

  if (!configuredPin) return true;

  const supplied =
    cleanText(req.headers["x-agv-admin-pin"] || "") ||
    cleanText(req.body?.adminPin || "") ||
    cleanText(req.query?.adminPin || "");

  return supplied === configuredPin;
}

function normalizeReport(body) {
  const fees = calculateFees(body || {});
  const plan = cleanPlan(body.plan || body.createdByPlan || body.currentPlan);

  return {
    id: cleanText(body.id) || uid("revenue"),

    eventName: cleanText(body.eventName || body.title || "Untitled AGV Event"),
    roomId: cleanText(body.roomId || body.room || "main-hall"),
    eventDate: cleanText(body.eventDate || body.date || ""),
    ticketsSold: cleanNumber(body.ticketsSold || body.ticketCount, 0),

    grossRevenue: fees.grossRevenue,
    refunds: fees.refunds,
    netRevenue: fees.netRevenue,
    feeRate: fees.feeRate,
    agvFee: fees.agvFee,

    gateway: cleanText(body.gateway || body.paymentGateway || "Not reported"),
    notes: cleanText(body.notes || body.vendorNotes || ""),

    status: cleanText(body.status || "Reported"),
    adminNotes: cleanText(body.adminNotes || ""),

    ownerId: cleanText(body.ownerId || body.requesterId || ""),
    ownerName: cleanText(body.ownerName || body.hostName || "AGV Host"),
    ownerEmail: cleanText(body.ownerEmail || body.requesterEmail || "").toLowerCase(),
    organization: cleanText(body.organization || body.ownerOrganization || "Not set"),
    plan,

    createdAt: cleanText(body.createdAt || nowIso()),
    updatedAt: nowIso(),
  };
}

async function initDatabase() {
  if (!pool) {
    databaseReady = false;
    databaseError = DATABASE_URL
      ? "pg package unavailable."
      : "DATABASE_URL not configured.";
    return false;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agv_revenue_reports (
        id TEXT PRIMARY KEY,
        report JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'Reported',
        owner_email TEXT,
        event_name TEXT,
        room_id TEXT,
        agv_fee NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    databaseReady = true;
    databaseError = "";
    return true;
  } catch (error) {
    databaseReady = false;
    databaseError = error.message || "Database initialization failed.";
    console.error("AGV revenue database init failed:", databaseError);
    return false;
  }
}

function ensureJsonFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ updatedAt: nowIso(), reports: [] }, null, 2),
      "utf8"
    );
  }
}

function loadReportsFromFile() {
  try {
    ensureJsonFile();

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (!Array.isArray(parsed.reports)) {
      return [];
    }

    return parsed.reports;
  } catch {
    return [];
  }
}

function saveReportsToFile(reports) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        updatedAt: nowIso(),
        storage: "json-file-fallback",
        reports,
      },
      null,
      2
    ),
    "utf8"
  );
}

async function loadReports() {
  if (databaseReady && pool) {
    const result = await pool.query(`
      SELECT report
      FROM agv_revenue_reports
      ORDER BY updated_at DESC, created_at DESC
    `);

    return result.rows.map((row) => row.report);
  }

  return loadReportsFromFile();
}

async function saveNewReport(report) {
  if (databaseReady && pool) {
    await pool.query(
      `
      INSERT INTO agv_revenue_reports (
        id,
        report,
        status,
        owner_email,
        event_name,
        room_id,
        agv_fee,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, NOW()), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        report = EXCLUDED.report,
        status = EXCLUDED.status,
        owner_email = EXCLUDED.owner_email,
        event_name = EXCLUDED.event_name,
        room_id = EXCLUDED.room_id,
        agv_fee = EXCLUDED.agv_fee,
        updated_at = NOW()
      `,
      [
        report.id,
        JSON.stringify(report),
        report.status,
        report.ownerEmail,
        report.eventName,
        report.roomId,
        report.agvFee,
        report.createdAt || null,
      ]
    );

    return loadReports();
  }

  const reports = loadReportsFromFile();
  const nextReports = [report, ...reports];
  saveReportsToFile(nextReports);
  return nextReports;
}

async function updateReportStatus(reportId, nextStatus, adminNotes) {
  if (databaseReady && pool) {
    const existing = await pool.query(
      `
      SELECT report
      FROM agv_revenue_reports
      WHERE id = $1
      LIMIT 1
      `,
      [reportId]
    );

    if (!existing.rows.length) {
      return { found: false, reports: await loadReports() };
    }

    const report = existing.rows[0].report;

    const updatedReport = {
      ...report,
      status: nextStatus,
      adminNotes,
      updatedAt: nowIso(),
    };

    await pool.query(
      `
      UPDATE agv_revenue_reports
      SET
        report = $2,
        status = $3,
        updated_at = NOW()
      WHERE id = $1
      `,
      [reportId, JSON.stringify(updatedReport), nextStatus]
    );

    return { found: true, report: updatedReport, reports: await loadReports() };
  }

  const reports = loadReportsFromFile();
  let found = false;
  let updated = null;

  const nextReports = reports.map((report) => {
    if (report.id !== reportId) return report;

    found = true;

    updated = {
      ...report,
      status: nextStatus,
      adminNotes,
      updatedAt: nowIso(),
    };

    return updated;
  });

  if (found) {
    saveReportsToFile(nextReports);
  }

  return { found, report: updated, reports: nextReports };
}

async function clearReports() {
  if (databaseReady && pool) {
    await pool.query("DELETE FROM agv_revenue_reports");
    return [];
  }

  saveReportsToFile([]);
  return [];
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "AGV Revenue Report Server",
    message: "AGV revenue server is running. Use /health for status.",
    routes: [
      "GET /health",
      "GET /api/revenue-reports",
      "POST /api/revenue-reports/create",
      "POST /api/revenue-reports/:id/status",
      "POST /api/revenue-reports/clear",
    ],
  });
});

app.get("/health", async (req, res) => {
  const reports = await loadReports();

  res.json({
    ok: true,
    service: "AGV Revenue Report Server",
    port: PORT,
    reports: reports.length,
    storage: databaseReady ? "database" : "json-file-fallback",
    databaseConfigured: Boolean(DATABASE_URL),
    databaseReady,
    databaseError,
    dataFile: DATA_FILE,
    adminPinConfigured: Boolean(process.env.AGV_REVENUE_ADMIN_PIN || process.env.AGV_ADMIN_PIN),
    timestamp: nowIso(),
  });
});

app.get("/api/revenue-reports", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({
      ok: false,
      error: "Revenue report admin access denied.",
    });
  }

  const reports = await loadReports();

  return res.json({
    ok: true,
    reports,
    count: reports.length,
    storage: databaseReady ? "database" : "json-file-fallback",
    timestamp: nowIso(),
  });
});

app.post("/api/revenue-reports/create", async (req, res) => {
  const report = normalizeReport(req.body || {});

  if (!report.eventName || report.eventName === "Untitled AGV Event") {
    return res.status(400).json({
      ok: false,
      error: "Event name is required.",
    });
  }

  if (report.grossRevenue <= 0) {
    return res.status(400).json({
      ok: false,
      error: "Gross collected ticket revenue must be greater than zero.",
    });
  }

  if (!report.gateway || report.gateway === "Not reported") {
    return res.status(400).json({
      ok: false,
      error: "Payment gateway used by host/vendor is required.",
    });
  }

  const nextReports = await saveNewReport(report);

  return res.status(201).json({
    ok: true,
    report,
    reports: nextReports,
    storage: databaseReady ? "database" : "json-file-fallback",
    message: `Revenue report saved. AGV 2% fee: $${report.agvFee.toFixed(2)}.`,
  });
});

app.post("/api/revenue-reports/:id/status", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({
      ok: false,
      error: "Revenue report admin access denied.",
    });
  }

  const reportId = cleanText(req.params.id);
  const nextStatus = cleanText(req.body.status || "");
  const adminNotes = cleanText(req.body.adminNotes || req.body.notes || "");

  const allowedStatuses = ["Reported", "Invoiced", "Paid", "Disputed", "Closed"];

  if (!allowedStatuses.includes(nextStatus)) {
    return res.status(400).json({
      ok: false,
      error: `Status must be one of: ${allowedStatuses.join(", ")}`,
    });
  }

  const result = await updateReportStatus(reportId, nextStatus, adminNotes);

  if (!result.found) {
    return res.status(404).json({
      ok: false,
      error: "Revenue report not found.",
    });
  }

  return res.json({
    ok: true,
    report: result.report,
    reports: result.reports,
    storage: databaseReady ? "database" : "json-file-fallback",
  });
});

app.post("/api/revenue-reports/clear", async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({
      ok: false,
      error: "Revenue report admin access denied.",
    });
  }

  const confirmed = cleanText(req.body.confirm || "");

  if (confirmed !== "CLEAR_AGV_REVENUE_REPORTS") {
    return res.status(400).json({
      ok: false,
      error: "Clear confirmation required.",
    });
  }

  const reports = await clearReports();

  return res.json({
    ok: true,
    reports,
    storage: databaseReady ? "database" : "json-file-fallback",
    message: "All revenue reports cleared.",
  });
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "AGV Revenue Report route not found.",
    path: req.path,
  });
});

async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log("AGV Revenue Report Server running on", PORT);
    console.log("STORAGE:", databaseReady ? "database" : "json-file-fallback");
    console.log("DATABASE CONFIGURED:", Boolean(DATABASE_URL));
    console.log("DATA FILE:", DATA_FILE);

    if (databaseError) {
      console.log("DATABASE STATUS:", databaseError);
    }
  });
}

start().catch((error) => {
  console.error("AGV Revenue Report Server failed to start:", error);
  process.exit(1);
});