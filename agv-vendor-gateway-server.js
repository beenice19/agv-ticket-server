// PASS LAUNCH-LOCK-3C.2 â€” AGV SERVER ONLY
// AGV Vendor Gateway Server
// Purpose: Vendor onboarding, payment gateway status, and Stripe Connect foundation.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const crypto = require("crypto");

const app = express();

const PORT = Number(process.env.AGV_VENDOR_GATEWAY_PORT || 8795);
const CLIENT_BASE_URL =
  process.env.AGV_APP_BASE_URL ||
  process.env.CLIENT_BASE_URL ||
  "http://127.0.0.1:5175";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const INTERNAL_SERVICE_TOKEN = String(
  process.env.AGV_INTERNAL_SERVICE_TOKEN || process.env.AGV_SERVICE_TOKEN || ""
).trim();

const DATA_FILE = path.join(__dirname, "agv-vendors.json");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function nowIso() {
  return new Date().toISOString();
}

function safeText(value) {
  return String(value || "").trim();
}

function safeEmail(value) {
  return safeText(value).toLowerCase();
}

// PASS_STRIPE_CONNECT_HOST_PAYMENTS_1A - Protected server-to-server payment routing.
function secureTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireInternalService(req, res, next) {
  if (!INTERNAL_SERVICE_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "Internal payment routing is not configured.",
    });
  }

  const suppliedToken = safeText(req.get("x-agv-internal-token"));
  if (!secureTokenEqual(suppliedToken, INTERNAL_SERVICE_TOKEN)) {
    return res.status(401).json({
      ok: false,
      error: "Internal service authentication failed.",
    });
  }

  next();
}

function makeVendorId() {
  return "vendor_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function readVendors() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { vendors: [] };
    }

    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8") || "{}");

    if (!Array.isArray(parsed.vendors)) {
      return { vendors: [] };
    }

    return parsed;
  } catch (error) {
    console.error("VENDOR READ FAILED:", error.message);
    return { vendors: [] };
  }
}

function writeVendors(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function publicVendor(vendor) {
  return {
    vendorId: vendor.vendorId,
    businessName: vendor.businessName,
    contactName: vendor.contactName,
    email: vendor.email,
    phone: vendor.phone,
    businessCategory: vendor.businessCategory,
    website: vendor.website,
    description: vendor.description,
    gateway: vendor.gateway,
    gatewayStatus: vendor.gatewayStatus,
    approvalStatus: vendor.approvalStatus,
    ticketSalesEnabled: Boolean(vendor.ticketSalesEnabled),
    stripeAccountId: vendor.stripeAccountId || "",
    chargesEnabled: Boolean(vendor.chargesEnabled),
    payoutsEnabled: Boolean(vendor.payoutsEnabled),
    detailsSubmitted: Boolean(vendor.detailsSubmitted),
    createdAt: vendor.createdAt,
    updatedAt: vendor.updatedAt,
  };
}

function findVendor(data, body = {}) {
  const vendorId = safeText(body.vendorId);
  const email = safeEmail(body.email);

  if (vendorId) {
    return data.vendors.find((v) => v.vendorId === vendorId);
  }

  if (email) {
    return data.vendors.find((v) => safeEmail(v.email) === email);
  }

  return null;
}

function upsertVendor(body = {}) {
  const data = readVendors();

  const email = safeEmail(body.email);
  if (!email) {
    return { error: "Vendor email is required." };
  }

  let vendor = findVendor(data, body);

  if (!vendor) {
    vendor = {
      vendorId: makeVendorId(),
      businessName: "",
      contactName: "",
      email,
      phone: "",
      businessCategory: "",
      website: "",
      description: "",
      gateway: "NONE",
      gatewayStatus: "NOT_CONNECTED",
      approvalStatus: "PENDING",
      ticketSalesEnabled: false,
      stripeAccountId: "",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    data.vendors.push(vendor);
  }

  vendor.businessName = safeText(body.businessName || vendor.businessName);
  vendor.contactName = safeText(body.contactName || body.ownerName || vendor.contactName);
  vendor.email = email;
  vendor.phone = safeText(body.phone || vendor.phone);
  vendor.businessCategory = safeText(body.businessCategory || body.category || vendor.businessCategory);
  vendor.website = safeText(body.website || vendor.website);
  vendor.description = safeText(body.description || vendor.vendorDescription || vendor.description);
  vendor.updatedAt = nowIso();

  writeVendors(data);

  return { data, vendor };
}

app.get("/api/vendor/health", (req, res) => {
  const data = readVendors();

  res.json({
    ok: true,
    service: "AGV Vendor Gateway Server",
    pass: "PASS-LAUNCH-LOCK-3C.2",
    port: PORT,
    stripeConfigured: Boolean(stripe),
    vendors: data.vendors.length,
    dataFile: "agv-vendors.json",
  });
});

app.post("/api/vendor/register", (req, res) => {
  const result = upsertVendor(req.body || {});

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  res.json({
    ok: true,
    vendor: publicVendor(result.vendor),
  });
});

app.post("/api/vendor/update", (req, res) => {
  const result = upsertVendor(req.body || {});

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  res.json({
    ok: true,
    vendor: publicVendor(result.vendor),
  });
});

app.get("/api/vendor/status", async (req, res) => {
  const data = readVendors();
  const vendor = findVendor(data, req.query || {});

  if (!vendor) {
    return res.status(404).json({
      ok: false,
      error: "Vendor not found.",
    });
  }

  if (stripe && vendor.stripeAccountId) {
    try {
      const account = await stripe.accounts.retrieve(vendor.stripeAccountId);

      vendor.chargesEnabled = Boolean(account.charges_enabled);
      vendor.payoutsEnabled = Boolean(account.payouts_enabled);
      vendor.detailsSubmitted = Boolean(account.details_submitted);
      vendor.gatewayStatus =
        vendor.chargesEnabled && vendor.payoutsEnabled
          ? "VERIFIED"
          : vendor.detailsSubmitted
          ? "PENDING_VERIFICATION"
          : "ONBOARDING_REQUIRED";
      vendor.updatedAt = nowIso();

      writeVendors(data);
    } catch (error) {
      console.error("STRIPE ACCOUNT STATUS FAILED:", error.message);
    }
  }

  res.json({
    ok: true,
    vendor: publicVendor(vendor),
  });
});

// PASS_STRIPE_CONNECT_HOST_PAYMENTS_1A
app.get("/api/vendor/internal/payment-routing", requireInternalService, async (req, res) => {
  const data = readVendors();
  const vendor = findVendor(data, req.query || {});

  if (!vendor) {
    return res.status(404).json({
      ok: false,
      error: "Host financial profile was not found.",
    });
  }

  if (stripe && vendor.gateway === "STRIPE" && vendor.stripeAccountId) {
    try {
      const account = await stripe.accounts.retrieve(vendor.stripeAccountId);
      vendor.chargesEnabled = Boolean(account.charges_enabled);
      vendor.payoutsEnabled = Boolean(account.payouts_enabled);
      vendor.detailsSubmitted = Boolean(account.details_submitted);
      vendor.gatewayStatus =
        vendor.chargesEnabled && vendor.payoutsEnabled
          ? "VERIFIED"
          : vendor.detailsSubmitted
          ? "PENDING_VERIFICATION"
          : "ONBOARDING_REQUIRED";
      vendor.updatedAt = nowIso();
      writeVendors(data);
    } catch (error) {
      console.error("INTERNAL STRIPE ROUTING STATUS FAILED:", error.message);
      return res.status(502).json({
        ok: false,
        error: "Stripe host-account status could not be verified.",
      });
    }
  }

  const approved = vendor.approvalStatus === "APPROVED";
  const ticketSalesEnabled = Boolean(vendor.ticketSalesEnabled);
  let eligible = false;
  let settlementMode = "BLOCKED";
  let reason = "";

  if (!approved) {
    reason = "Host financial profile is not approved.";
  } else if (!ticketSalesEnabled) {
    reason = "Ticket sales are not enabled for this host.";
  } else if (
    vendor.gateway === "STRIPE" &&
    vendor.gatewayStatus === "VERIFIED" &&
    vendor.stripeAccountId &&
    vendor.chargesEnabled &&
    vendor.payoutsEnabled
  ) {
    eligible = true;
    settlementMode = "STRIPE_CONNECT";
  } else if (
    vendor.gateway === "AGV_GATEWAY" &&
    vendor.gatewayStatus === "AGV_GATEWAY_ACTIVE"
  ) {
    eligible = true;
    settlementMode = "AGV_GATEWAY";
  } else {
    reason = "The selected host payment gateway is not ready for ticket settlement.";
  }

  res.json({
    ok: true,
    eligible,
    settlementMode,
    reason,
    vendorId: vendor.vendorId,
    gateway: vendor.gateway,
    gatewayStatus: vendor.gatewayStatus,
    approvalStatus: vendor.approvalStatus,
    ticketSalesEnabled,
    stripeAccountId:
      eligible && settlementMode === "STRIPE_CONNECT"
        ? vendor.stripeAccountId
        : "",
    chargesEnabled: Boolean(vendor.chargesEnabled),
    payoutsEnabled: Boolean(vendor.payoutsEnabled),
    detailsSubmitted: Boolean(vendor.detailsSubmitted),
  });
});

app.get("/api/vendor/list", (req, res) => {
  const data = readVendors();

  res.json({
    ok: true,
    vendors: data.vendors.map(publicVendor),
  });
});

app.post("/api/vendor/approve", (req, res) => {
  const data = readVendors();
  const vendor = findVendor(data, req.body || {});

  if (!vendor) {
    return res.status(404).json({ ok: false, error: "Vendor not found." });
  }

  vendor.approvalStatus = "APPROVED";
  vendor.ticketSalesEnabled = vendor.gatewayStatus === "VERIFIED";
  vendor.updatedAt = nowIso();

  writeVendors(data);

  res.json({
    ok: true,
    vendor: publicVendor(vendor),
  });
});

app.post("/api/vendor/suspend", (req, res) => {
  const data = readVendors();
  const vendor = findVendor(data, req.body || {});

  if (!vendor) {
    return res.status(404).json({ ok: false, error: "Vendor not found." });
  }

  vendor.approvalStatus = "SUSPENDED";
  vendor.ticketSalesEnabled = false;
  vendor.updatedAt = nowIso();

  writeVendors(data);

  res.json({
    ok: true,
    vendor: publicVendor(vendor),
  });
});

app.post("/api/vendor/connect/stripe", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({
        ok: false,
        error: "Stripe is not configured. STRIPE_SECRET_KEY is missing.",
      });
    }

    const result = upsertVendor({
      ...req.body,
      gateway: "STRIPE",
    });

    if (result.error) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    const data = result.data;
    const vendor = result.vendor;

    vendor.gateway = "STRIPE";

    if (!vendor.stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: vendor.email,
        business_type: "company",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          agvVendorId: vendor.vendorId,
          agvBusinessName: vendor.businessName || "",
        },
      });

      vendor.stripeAccountId = account.id;
    }

    vendor.gatewayStatus = "ONBOARDING_REQUIRED";
    vendor.updatedAt = nowIso();

    writeVendors(data);

    const refreshUrl =
      `${CLIENT_BASE_URL}?agvVendorGateway=refresh&vendorId=${encodeURIComponent(vendor.vendorId)}`;
    const returnUrl =
      `${CLIENT_BASE_URL}?agvVendorGateway=return&vendorId=${encodeURIComponent(vendor.vendorId)}`;

    const accountLink = await stripe.accountLinks.create({
      account: vendor.stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: "account_onboarding",
    });

    res.json({
      ok: true,
      gateway: "STRIPE",
      onboardingUrl: accountLink.url,
      vendor: publicVendor(vendor),
    });
  } catch (error) {
    console.error("STRIPE CONNECT FAILED:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Stripe Connect onboarding failed.",
    });
  }
});

app.post("/api/vendor/connect/agv-gateway", (req, res) => {
  const result = upsertVendor({
    ...req.body,
    gateway: "AGV_GATEWAY",
  });
  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  result.vendor.gateway = "AGV_GATEWAY";
  result.vendor.gatewayStatus = "AGV_GATEWAY_ACTIVE";
  result.vendor.approvalStatus = "APPROVED";
  result.vendor.ticketSalesEnabled = true;
  result.vendor.detailsSubmitted = true;
  result.vendor.updatedAt = nowIso();
  writeVendors(result.data);
  res.json({
    ok: true,
    gateway: "AGV_GATEWAY",
    agvGateway: true,
    ticketSalesEnabled: true,
    message: "AGV Stripe Gateway selected. AGV will collect ticket payments and track host/vendor settlement.",
    vendor: publicVendor(result.vendor),
  });
});app.post("/api/vendor/connect/paypal", (req, res) => {
  const result = upsertVendor({
    ...req.body,
    gateway: "PAYPAL",
  });

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  result.vendor.gateway = "PAYPAL";
  result.vendor.gatewayStatus = "MANUAL_REVIEW";
  result.vendor.updatedAt = nowIso();
  writeVendors(result.data);

  res.json({
    ok: true,
    gateway: "PAYPAL",
    manual: true,
    message: "PayPal Business onboarding is marked for manual review in this MVP.",
    vendor: publicVendor(result.vendor),
  });
});

app.post("/api/vendor/connect/square", (req, res) => {
  const result = upsertVendor({
    ...req.body,
    gateway: "SQUARE",
  });

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  result.vendor.gateway = "SQUARE";
  result.vendor.gatewayStatus = "MANUAL_REVIEW";
  result.vendor.updatedAt = nowIso();
  writeVendors(result.data);

  res.json({
    ok: true,
    gateway: "SQUARE",
    manual: true,
    message: "Square onboarding is marked for manual review in this MVP.",
    vendor: publicVendor(result.vendor),
  });
});

app.post("/api/vendor/connect/manual", (req, res) => {
  const result = upsertVendor({
    ...req.body,
    gateway: "MANUAL",
  });

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  result.vendor.gateway = "MANUAL";
  result.vendor.gatewayStatus = "MANUAL_REVIEW";
  result.vendor.updatedAt = nowIso();
  writeVendors(result.data);

  res.json({
    ok: true,
    gateway: "MANUAL",
    manual: true,
    message: "Manual settlement selected. Host/admin review is required before ticket sales.",
    vendor: publicVendor(result.vendor),
  });
});

app.listen(PORT, () => {
  console.log("AGV VENDOR GATEWAY SERVER RUNNING ON", PORT);
  console.log("STRIPE CONNECT CONFIGURED:", Boolean(stripe));
  console.log("CLIENT BASE URL:", CLIENT_BASE_URL);
});
