const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "agv-lc2-05h-")
);

const ledgerFile = path.join(
  temporaryDirectory,
  "certification-host-ledger.json"
);

const settlementsFile = path.join(
  temporaryDirectory,
  "certification-host-settlements.json"
);

process.env.AGV_HOST_LEDGER_FILE = ledgerFile;
process.env.AGV_HOST_SETTLEMENTS_FILE = settlementsFile;

const {
  creditHostLedger,
  releasePendingHostFunds,
  recordHostPayout,
  readHostLedger,
  readHostSettlements,
} = require("./ticket-server.js");

const HOST_ID = "lc2-05h-certification-host";
const SALE_SOURCE_ID = "lc2-05h-ticket-sale-001";
const RELEASE_SOURCE_ID = "lc2-05h-release-001";
const PAYOUT_SOURCE_ID = "lc2-05h-payout-001";
const AMOUNT_CENTS = 1000;

const results = [];

function assertEqual(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
    );
  }

  results.push({
    test: name,
    status: "PASS",
    actual,
  });
}

function assertTrue(name, value) {
  assertEqual(name, Boolean(value), true);
}

function assertThrows(name, action, expectedMessage) {
  let caughtError = null;

  try {
    action();
  } catch (error) {
    caughtError = error;
  }

  if (!caughtError) {
    throw new Error(`${name}: expected an error, but none was thrown.`);
  }

  if (
    expectedMessage &&
    !String(caughtError.message || "").includes(expectedMessage)
  ) {
    throw new Error(
      `${name}: unexpected error message: ${caughtError.message}`
    );
  }

  results.push({
    test: name,
    status: "PASS",
    actual: caughtError.message,
  });
}

try {
  assertTrue(
    "Certification ledger uses isolated temporary path",
    ledgerFile.startsWith(temporaryDirectory)
  );

  assertTrue(
    "Certification settlements use isolated temporary path",
    settlementsFile.startsWith(temporaryDirectory)
  );

  const credit = creditHostLedger({
    hostId: HOST_ID,
    sourceType: "TICKET_SALE",
    sourceId: SALE_SOURCE_ID,
    amountCents: AMOUNT_CENTS,
    ticketCode: "AGV-LC205H",
    checkoutId: "checkout-lc2-05h",
    eventName: "LC2-05H Settlement Certification",
    roomId: "certification-room",
  });

  assertEqual("Initial host credit created", credit.credited, true);
  assertEqual("Initial credit is not duplicate", credit.duplicate, false);
  assertEqual(
    "Credit posts to pending balance",
    credit.account.pendingBalanceCents,
    AMOUNT_CENTS
  );
  assertEqual(
    "Credit does not post directly to available",
    credit.account.availableBalanceCents,
    0
  );
  assertEqual(
    "Lifetime earnings record host net",
    credit.account.lifetimeEarningsCents,
    AMOUNT_CENTS
  );

  const duplicateCredit = creditHostLedger({
    hostId: HOST_ID,
    sourceType: "TICKET_SALE",
    sourceId: SALE_SOURCE_ID,
    amountCents: AMOUNT_CENTS,
  });

  assertEqual(
    "Duplicate ticket credit is blocked",
    duplicateCredit.duplicate,
    true
  );

  assertThrows(
    "Release above pending balance is blocked",
    () =>
      releasePendingHostFunds({
        hostId: HOST_ID,
        amountCents: AMOUNT_CENTS + 1,
        sourceId: "lc2-05h-invalid-release",
      }),
    "exceeds the host pending balance"
  );

  const release = releasePendingHostFunds({
    hostId: HOST_ID,
    amountCents: AMOUNT_CENTS,
    sourceId: RELEASE_SOURCE_ID,
    note: "LC2-05H controlled pending-fund release",
  });

  assertEqual("Pending funds released", release.released, true);
  assertEqual("Release is not duplicate", release.duplicate, false);
  assertEqual(
    "Pending balance becomes zero",
    release.account.pendingBalanceCents,
    0
  );
  assertEqual(
    "Released funds become available",
    release.account.availableBalanceCents,
    AMOUNT_CENTS
  );

  const duplicateRelease = releasePendingHostFunds({
    hostId: HOST_ID,
    amountCents: AMOUNT_CENTS,
    sourceId: RELEASE_SOURCE_ID,
  });

  assertEqual(
    "Duplicate settlement release is blocked",
    duplicateRelease.duplicate,
    true
  );

  assertThrows(
    "Payout above available balance is blocked",
    () =>
      recordHostPayout({
        hostId: HOST_ID,
        amountCents: AMOUNT_CENTS + 1,
        sourceId: "lc2-05h-invalid-payout",
      }),
    "exceeds the available balance"
  );

  const payout = recordHostPayout({
    hostId: HOST_ID,
    amountCents: AMOUNT_CENTS,
    sourceId: PAYOUT_SOURCE_ID,
    settlementMethod: "CERTIFICATION",
    externalReference: "LC2-05H-NO-REAL-MONEY",
    note: "Simulated payout only",
  });

  assertEqual("Host payout recorded", payout.paid, true);
  assertEqual("Payout is not duplicate", payout.duplicate, false);
  assertEqual(
    "Available balance becomes zero",
    payout.account.availableBalanceCents,
    0
  );
  assertEqual(
    "Lifetime payouts increase once",
    payout.account.lifetimePayoutsCents,
    AMOUNT_CENTS
  );

  const duplicatePayout = recordHostPayout({
    hostId: HOST_ID,
    amountCents: AMOUNT_CENTS,
    sourceId: PAYOUT_SOURCE_ID,
    settlementMethod: "CERTIFICATION",
  });

  assertEqual(
    "Duplicate payout is blocked",
    duplicatePayout.duplicate,
    true
  );

  const finalLedger = readHostLedger();
  const finalSettlements = readHostSettlements();
  const finalAccount = finalLedger.accounts[HOST_ID];

  assertEqual("Final pending balance", finalAccount.pendingBalanceCents, 0);
  assertEqual(
    "Final available balance",
    finalAccount.availableBalanceCents,
    0
  );
  assertEqual(
    "Final lifetime earnings",
    finalAccount.lifetimeEarningsCents,
    AMOUNT_CENTS
  );
  assertEqual(
    "Final lifetime payouts",
    finalAccount.lifetimePayoutsCents,
    AMOUNT_CENTS
  );
  assertEqual("Ledger audit entry count", finalLedger.entries.length, 3);
  assertEqual(
    "Settlement audit record count",
    finalSettlements.settlements.length,
    2
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        certification: "LC2-05H",
        status: "PASS",
        realMoneyMoved: false,
        liveLedgerTouched: false,
        testCount: results.length,
        hostId: HOST_ID,
        finalAccount,
        ledgerEntryCount: finalLedger.entries.length,
        settlementCount: finalSettlements.settlements.length,
        results,
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        certification: "LC2-05H",
        status: "FAIL",
        realMoneyMoved: false,
        liveLedgerTouched: false,
        error: error.message,
        completedTests: results,
      },
      null,
      2
    )
  );

  process.exitCode = 1;
} finally {
  fs.rmSync(temporaryDirectory, {
    recursive: true,
    force: true,
  });
}