const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8794);
const DATA_FILE = path.join(__dirname, "agv-revenue-reports.json");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix = "rev") {
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

  if (["FREE", "CREATOR", "MINISTRY", "CONVENTION"].includes(plan)) {
    return plan;
  }

  return "FREE";
}

function loadReports() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify({ updatedAt: nowIso(), reports: [] }, null, 2),
        "utf8"
      );
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    if (!Array.isArray(parsed.reports)) {
      return [];
    }

    return parsed.reports;
  } catch {
    return [];
  }
}

function saveReports(reports) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      {
        updatedAt: nowIso(),
        reports,
      },
      null,
      2
    ),
    "utf8"
  );
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

  // Local development safety: if no pin is configured, allow admin actions.
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

app.get("/health", (req, res) => {
  const reports = loadReports();

  res.json({
    ok: true,
    service: "AGV Revenue Report Server",
    port: PORT,
    reports: reports.length,
    dataFile: DATA_FILE,
    adminPinConfigured: Boolean(process.env.AGV_REVENUE_ADMIN_PIN || process.env.AGV_ADMIN_PIN),
    timestamp: nowIso(),
  });
});

app.get("/api/revenue-reports", (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(401).json({
      ok: false,
      error: "Revenue report admin access denied.",
    });
  }

  const reports = loadReports();

  return res.json({
    ok: true,
    reports,
    count: reports.length,
    timestamp: nowIso(),
  });
});

app.post("/api/revenue-reports/create", (req, res) => {
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

  const reports = loadReports();
  const nextReports = [report, ...reports];

  saveReports(nextReports);

  return res.status(201).json({
    ok: true,
    report,
    reports: nextReports,
    message: `Revenue report saved. AGV 2% fee: $${report.agvFee.toFixed(2)}.`,
  });
});

app.post("/api/revenue-reports/:id/status", (req, res) => {
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

  const reports = loadReports();
  let found = false;

  const nextReports = reports.map((report) => {
    if (report.id !== reportId) return report;

    found = true;

    return {
      ...report,
      status: nextStatus,
      adminNotes,
      updatedAt: nowIso(),
    };
  });

  if (!found) {
    return res.status(404).json({
      ok: false,
      error: "Revenue report not found.",
    });
  }

  saveReports(nextReports);

  return res.json({
    ok: true,
    report: nextReports.find((report) => report.id === reportId),
    reports: nextReports,
  });
});

app.post("/api/revenue-reports/clear", (req, res) => {
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

  saveReports([]);

  return res.json({
    ok: true,
    reports: [],
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

app.listen(PORT, () => {
  console.log("AGV Revenue Report Server running on", PORT);
  console.log("DATA FILE:", DATA_FILE);
});