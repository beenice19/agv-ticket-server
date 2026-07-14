const { supabaseAdmin, isSupabaseAdminReady } = require("./supabaseAdmin");
const TABLE_NAME = "agv_subscription_state";
const STATE_KEY = "primary";
function isSubscriptionPersistenceReady() {
  return Boolean(isSupabaseAdminReady() && supabaseAdmin);
}
async function loadSubscriptionState() {
  if (!isSubscriptionPersistenceReady()) {
    return {
      ok: false,
      found: false,
      reason: "SUPABASE_NOT_CONFIGURED",
      payload: null,
    };
  }
  try {
    const { data, error } = await supabaseAdmin
      .from(TABLE_NAME)
      .select("payload, updated_at")
      .eq("state_key", STATE_KEY)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        found: false,
        reason: "SUPABASE_READ_FAILED",
        error: error.message,
        payload: null,
      };
    }
    if (!data?.payload) {
      return {
        ok: true,
        found: false,
        reason: "STATE_NOT_FOUND",
        payload: null,
      };
    }
    return {
      ok: true,
      found: true,
      reason: "STATE_LOADED",
      payload: data.payload,
      updatedAt: data.updated_at || "",
    };
  } catch (error) {
    return {
      ok: false,
      found: false,
      reason: "SUPABASE_READ_ERROR",
      error: error?.message || "Unknown Supabase read error.",
      payload: null,
    };
  }
}
async function saveSubscriptionState(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "INVALID_PAYLOAD",
    };
  }
  if (!isSubscriptionPersistenceReady()) {
    return {
      ok: false,
      reason: "SUPABASE_NOT_CONFIGURED",
    };
  }
  try {
    const updatedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from(TABLE_NAME)
      .upsert(
        {
          state_key: STATE_KEY,
          payload,
          updated_at: updatedAt,
        },
        {
          onConflict: "state_key",
        }
      );
    if (error) {
      return {
        ok: false,
        reason: "SUPABASE_WRITE_FAILED",
        error: error.message,
      };
    }
    return {
      ok: true,
      reason: "STATE_SAVED",
      updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "SUPABASE_WRITE_ERROR",
      error: error?.message || "Unknown Supabase write error.",
    };
  }
}
module.exports = {
  TABLE_NAME,
  STATE_KEY,
  isSubscriptionPersistenceReady,
  loadSubscriptionState,
  saveSubscriptionState,
};