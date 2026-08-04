const crypto = require("crypto");
const {
  createClient,
} = require("@supabase/supabase-js");

const TABLE =
  "agv_media_intake_registry";

const REGISTRY_KEY =
  "agv-controlled-media-primary";

let client = null;

let writeQueue =
  Promise.resolve();

let lastWriteError = "";

function getConfiguration() {
  const url = String(
    process.env.SUPABASE_URL || ""
  ).trim();

  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  ).trim();

  return {
    url,
    key,
    configured: Boolean(url && key),
  };
}

function getClient() {
  if (client) {
    return client;
  }

  const configuration =
    getConfiguration();

  if (!configuration.configured) {
    return null;
  }

  client = createClient(
    configuration.url,
    configuration.key,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }
  );

  return client;
}

function countFounderDecisions(records) {
  return records.filter((record) =>
    /founderAdminDecision|founderPublicAccessDecision|founderDecision/i
      .test(JSON.stringify(record))
  ).length;
}

function cloneRecords(records) {
  return JSON.parse(
    JSON.stringify(records)
  );
}

function createSnapshotHash(records) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(records)
    )
    .digest("hex")
    .toUpperCase();
}

async function loadMediaRegistrySnapshot() {
  const supabase =
    getClient();

  if (!supabase) {
    return {
      configured: false,
      found: false,
      records: null,
      recordCount: 0,
      founderDecisionCount: 0,
      sourceSha256: "",
      updatedAt: "",
    };
  }

  const {
    data,
    error,
  } = await supabase
    .from(TABLE)
    .select(
      "registry_key,records,record_count,founder_decision_count,source_sha256,updated_at"
    )
    .eq(
      "registry_key",
      REGISTRY_KEY
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `${error.code || "REGISTRY_LOAD_ERROR"}: ${error.message}`
    );
  }

  if (!data) {
    return {
      configured: true,
      found: false,
      records: null,
      recordCount: 0,
      founderDecisionCount: 0,
      sourceSha256: "",
      updatedAt: "",
    };
  }

  if (!Array.isArray(data.records)) {
    throw new Error(
      "The Supabase media registry snapshot is not a JSON array."
    );
  }

  const records =
    cloneRecords(data.records);

  const actualRecordCount =
    records.length;

  const actualFounderDecisionCount =
    countFounderDecisions(records);

  if (
    Number(data.record_count) !==
    actualRecordCount
  ) {
    throw new Error(
      "Supabase media registry record-count verification failed."
    );
  }

  if (
    Number(
      data.founder_decision_count
    ) !== actualFounderDecisionCount
  ) {
    throw new Error(
      "Supabase Founder Decision count verification failed."
    );
  }

  return {
    configured: true,
    found: true,
    records,
    recordCount:
      actualRecordCount,
    founderDecisionCount:
      actualFounderDecisionCount,
    sourceSha256:
      String(
        data.source_sha256 || ""
      ).toUpperCase(),
    updatedAt:
      String(data.updated_at || ""),
  };
}

function queueMediaRegistrySnapshot(records) {
  if (!Array.isArray(records)) {
    return Promise.reject(
      new Error(
        "Media registry save requires a JSON array."
      )
    );
  }

  const snapshot =
    cloneRecords(records);

  const supabase =
    getClient();

  if (!supabase) {
    return Promise.resolve({
      configured: false,
      written: false,
    });
  }

  const operation =
    writeQueue
      .catch(() => undefined)
      .then(async () => {
        const recordCount =
          snapshot.length;

        const founderDecisionCount =
          countFounderDecisions(
            snapshot
          );

        const sourceSha256 =
          createSnapshotHash(
            snapshot
          );

        const {
          error,
        } = await supabase
          .from(TABLE)
          .upsert(
            {
              registry_key:
                REGISTRY_KEY,

              records:
                snapshot,

              record_count:
                recordCount,

              founder_decision_count:
                founderDecisionCount,

              source_sha256:
                sourceSha256,

              updated_at:
                new Date().toISOString(),
            },
            {
              onConflict:
                "registry_key",
            }
          );

        if (error) {
          throw new Error(
            `${error.code || "REGISTRY_WRITE_ERROR"}: ${error.message}`
          );
        }

        lastWriteError = "";

        return {
          configured: true,
          written: true,
          recordCount,
          founderDecisionCount,
          sourceSha256,
        };
      });

  writeQueue =
    operation.catch((error) => {
      lastWriteError =
        String(
          error.message || error
        );

      throw error;
    });

  return writeQueue;
}

async function flushMediaRegistryWrites() {
  await writeQueue;

  return {
    flushed: true,
    lastWriteError,
  };
}

function getMediaRegistryAdapterStatus() {
  const configuration =
    getConfiguration();

  return {
    configured:
      configuration.configured,
    table:
      TABLE,
    registryKey:
      REGISTRY_KEY,
    lastWriteError,
  };
}

module.exports = {
  loadMediaRegistrySnapshot,
  queueMediaRegistrySnapshot,
  flushMediaRegistryWrites,
  getMediaRegistryAdapterStatus,
};