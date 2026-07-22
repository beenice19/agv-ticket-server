require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    ""
).trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "LC2-06B MIGRATION FAILED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required."
  );
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

const root = __dirname;
const ledgerPath = path.join(root, "agv-host-balance-ledger.json");
const settlementsPath = path.join(root, "agv-host-settlements.json");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function accountToRow(account) {
  const hostId = String(account?.hostId || "").trim();

  return {
    record_id: `account:${hostId}`,
    record_type: "ACCOUNT",
    host_id: hostId,
    idempotency_key: null,
    entry_type: null,
    balance_bucket: null,
    source_type: null,
    source_id: null,
    amount_cents: null,
    status: "ACTIVE",
    settlement_id: null,
    payload: account || {},
    created_at:
      account?.createdAt ||
      account?.updatedAt ||
      new Date().toISOString(),
    updated_at:
      account?.updatedAt ||
      account?.lastLedgerEntryAt ||
      new Date().toISOString(),
  };
}

function entryToRow(entry) {
  return {
    record_id: String(entry?.entryId || "").trim(),
    record_type: "ENTRY",
    host_id: String(entry?.hostId || "").trim(),
    idempotency_key: String(entry?.idempotencyKey || "").trim() || null,
    entry_type: String(entry?.entryType || "").trim() || null,
    balance_bucket: String(entry?.balanceBucket || "").trim() || null,
    source_type: String(entry?.sourceType || "").trim() || null,
    source_id: String(entry?.sourceId || "").trim() || null,
    amount_cents: Number.isFinite(Number(entry?.amountCents))
      ? Math.round(Number(entry.amountCents))
      : null,
    status: String(entry?.status || "").trim() || null,
    settlement_id: String(entry?.settlementId || "").trim() || null,
    payload: entry || {},
    created_at: entry?.createdAt || new Date().toISOString(),
    updated_at: entry?.updatedAt || entry?.createdAt || new Date().toISOString(),
  };
}

function settlementToRow(settlement) {
  return {
    settlement_id: String(settlement?.settlementId || "").trim(),
    idempotency_key: String(settlement?.idempotencyKey || "").trim(),
    host_id: String(settlement?.hostId || "").trim(),
    settlement_type: String(settlement?.settlementType || "").trim(),
    settlement_method:
      String(settlement?.settlementMethod || "").trim() || null,
    amount_cents: Math.round(Number(settlement?.amountCents || 0)),
    source_id: String(settlement?.sourceId || "").trim(),
    external_reference:
      String(settlement?.externalReference || "").trim() || null,
    status: String(settlement?.status || "").trim(),
    note: String(settlement?.note || "").trim() || null,
    payload: settlement || {},
    created_at: settlement?.createdAt || new Date().toISOString(),
    completed_at: settlement?.completedAt || null,
    paid_at: settlement?.paidAt || null,
    updated_at:
      settlement?.updatedAt ||
      settlement?.completedAt ||
      settlement?.paidAt ||
      settlement?.createdAt ||
      new Date().toISOString(),
  };
}

async function main() {
  const ledgerData = readJson(ledgerPath, {
    accounts: {},
    entries: [],
  });

  const settlementData = readJson(settlementsPath, {
    settlements: [],
  });

  const accountRows = Object.values(ledgerData.accounts || {})
    .filter((account) => account && account.hostId)
    .map(accountToRow);

  const entryRows = (Array.isArray(ledgerData.entries)
    ? ledgerData.entries
    : []
  )
    .filter((entry) => entry && entry.entryId && entry.hostId)
    .map(entryToRow);

  const settlementRows = (Array.isArray(settlementData.settlements)
    ? settlementData.settlements
    : []
  )
    .filter(
      (settlement) =>
        settlement &&
        settlement.settlementId &&
        settlement.idempotencyKey &&
        settlement.hostId
    )
    .map(settlementToRow);

  const ledgerRows = [...accountRows, ...entryRows];

  console.log("LC2-06B HOST SETTLEMENT MIGRATION");
  console.log("Ledger accounts:", accountRows.length);
  console.log("Ledger entries:", entryRows.length);
  console.log("Settlements:", settlementRows.length);

  if (ledgerRows.length) {
    const { error } = await supabase
      .from("agv_host_balance_ledger")
      .upsert(ledgerRows, { onConflict: "record_id" });

    if (error) {
      throw new Error(`Ledger migration failed: ${error.message}`);
    }
  }

  if (settlementRows.length) {
    const { error } = await supabase
      .from("agv_host_settlements")
      .upsert(settlementRows, { onConflict: "settlement_id" });

    if (error) {
      throw new Error(`Settlement migration failed: ${error.message}`);
    }
  }

  const { data: ledgerCheck, error: ledgerCheckError } = await supabase
    .from("agv_host_balance_ledger")
    .select("record_id", { head: false })
    .limit(1);

  if (ledgerCheckError) {
    throw new Error(`Ledger verification failed: ${ledgerCheckError.message}`);
  }

  const { data: settlementCheck, error: settlementCheckError } =
    await supabase
      .from("agv_host_settlements")
      .select("settlement_id", { head: false })
      .limit(1);

  if (settlementCheckError) {
    throw new Error(
      `Settlement verification failed: ${settlementCheckError.message}`
    );
  }

  console.log("LC2-06B MIGRATION COMPLETE");
  console.log("Ledger table reachable:", Array.isArray(ledgerCheck));
  console.log(
    "Settlement table reachable:",
    Array.isArray(settlementCheck)
  );
  console.log("Real money moved: false");
}

main().catch((error) => {
  console.error("LC2-06B MIGRATION FAILED:", error.message);
  process.exit(1);
});
