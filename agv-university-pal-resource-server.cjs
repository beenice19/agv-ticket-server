"use strict";

/*
  AGV UNIVERSITY PAL RESOURCE SERVER
  PASS 12A

  Isolated service:
    Default port: 8802

  Security:
    - Verifies AGV host-session JWTs.
    - Verifies each handout's private edit token.
    - Uses the Supabase service role only on the SERVER.
    - Never exposes the service-role key to the browser.
    - Keeps the Storage bucket private.
    - Public student reads receive temporary signed URLs.

  Supported resources:
    PDF, TXT, DOC, DOCX, XLS, XLSX, MP4,
    Google Drive links, and approved HTTPS resources.
*/

const path = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const {
  createClient,
} = require("@supabase/supabase-js");

const PASS = "AGV_UP_RESOURCE_SERVER_12A";

const HOST = String(
  process.env.AGV_UNIVERSITY_PAL_RESOURCE_HOST ||
  "0.0.0.0"
).trim();

const PORT = Number(
  process.env.AGV_UNIVERSITY_PAL_RESOURCE_PORT ||
  process.env.PORT ||
  8802
);

const SUPABASE_URL = String(
  process.env.SUPABASE_URL || ""
).trim();

const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

const AGV_SESSION_SECRET = String(
  process.env.AGV_SESSION_SECRET || ""
).trim();

const RESOURCE_TICKET_SECRET = String(
  process.env.AGV_UP_RESOURCE_TICKET_SECRET ||
  AGV_SESSION_SECRET ||
  ""
).trim();

const STORAGE_BUCKET = String(
  process.env.AGV_UP_RESOURCE_BUCKET ||
  "agv-university-pal-resources"
).trim();

const MAX_UPLOAD_BYTES = Math.max(
  1,
  Number(
    process.env.AGV_UP_RESOURCE_MAX_BYTES ||
    5368709120
  )
);

const READ_URL_TTL_SECONDS = Math.max(
  60,
  Number(
    process.env.AGV_UP_RESOURCE_READ_URL_TTL_SECONDS ||
    3600
  )
);

const HANDOUT_TABLE =
  "agv_up_student_handouts";

const RESOURCE_TABLE =
  "agv_up_student_resources";

const FILE_TYPES = Object.freeze({
  ".pdf": {
    mime: "application/pdf",
    displayMode: "inline",
    category: "Study Guide",
  },

  ".txt": {
    mime: "text/plain",
    displayMode: "inline",
    category: "Class Notes",
  },

  ".doc": {
    mime: "application/msword",
    displayMode: "download",
    category: "Workbook",
  },

  ".docx": {
    mime:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    displayMode: "download",
    category: "Workbook",
  },

  ".xls": {
    mime: "application/vnd.ms-excel",
    displayMode: "download",
    category: "Workbook",
  },

  ".xlsx": {
    mime:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    displayMode: "download",
    category: "Workbook",
  },

  ".mp4": {
    mime: "video/mp4",
    displayMode: "video",
    category: "Video Lesson",
  },
});

const ALLOWED_MIME_TYPES = [
  ...new Set(
    Object.values(FILE_TYPES).map(
      (definition) => definition.mime
    )
  ),
];

const DEFAULT_ORIGINS = [
  "http://127.0.0.1:5175",
  "http://localhost:5175",
  "https://agv-client.vercel.app",
  "https://www.agvision.show",
  "https://agvision.show",
];

const CONFIGURED_ORIGINS = String(
  process.env.AGV_UNIVERSITY_PAL_ALLOWED_ORIGINS ||
  ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...CONFIGURED_ORIGINS,
]);

const configured = Boolean(
  SUPABASE_URL &&
  SUPABASE_SERVICE_ROLE_KEY &&
  AGV_SESSION_SECRET &&
  RESOURCE_TICKET_SECRET
);

const supabaseAdmin = configured
  ? createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    )
  : null;

const app = express();

let storageBucketReady = false;
let storageBootstrapError = "";

class HttpError extends Error {
  constructor(status, message, code = "") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function asyncRoute(handler) {
  return function wrappedAsyncRoute(
    request,
    response,
    next
  ) {
    Promise.resolve(
      handler(request, response, next)
    ).catch(next);
  };
}

function cleanText(value, maximum = 500) {
  return String(value == null ? "" : value)
    .trim()
    .slice(0, maximum);
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function cleanUuid(value) {
  const normalized = cleanText(value, 64);

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(normalized)
  ) {
    return "";
  }

  return normalized.toLowerCase();
}

function booleanValue(value, fallback = false) {
  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  return fallback;
}

function integerValue(value, fallback = 0) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function bearerToken(request) {
  const authorization = cleanText(
    request.headers.authorization,
    20000
  );

  if (
    !authorization
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    return "";
  }

  return authorization.slice(7).trim();
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim(), "utf8")
    .digest("hex");
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(
    String(left || ""),
    "utf8"
  );

  const rightBuffer = Buffer.from(
    String(right || ""),
    "utf8"
  );

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    leftBuffer,
    rightBuffer
  );
}

function sanitizeOriginalFileName(value) {
  const original = path
    .basename(cleanText(value, 240))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();

  if (!original) {
    throw new HttpError(
      400,
      "A file name is required.",
      "FILE_NAME_REQUIRED"
    );
  }

  return original;
}

function safeStorageFileName(originalName) {
  const extension = path
    .extname(originalName)
    .toLowerCase();

  const baseName = path
    .basename(originalName, extension)
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100) || "resource";

  return baseName + extension;
}

function validateFileMetadata(input) {
  const originalFileName =
    sanitizeOriginalFileName(
      input?.originalFileName ||
      input?.name
    );

  const extension = path
    .extname(originalFileName)
    .toLowerCase();

  const definition = FILE_TYPES[extension];

  if (!definition) {
    throw new HttpError(
      415,
      "Unsupported file type. Use PDF, TXT, DOC, DOCX, XLS, XLSX, or MP4.",
      "UNSUPPORTED_FILE_TYPE"
    );
  }

  const fileSizeBytes = Number(
    input?.fileSizeBytes ??
    input?.size ??
    0
  );

  if (
    !Number.isFinite(fileSizeBytes) ||
    fileSizeBytes <= 0
  ) {
    throw new HttpError(
      400,
      "A valid file size is required.",
      "INVALID_FILE_SIZE"
    );
  }

  if (fileSizeBytes > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      413,
      "The selected file exceeds the AGV University Pal upload limit.",
      "FILE_TOO_LARGE"
    );
  }

  const suppliedMime = cleanText(
    input?.mimeType ||
    input?.type,
    180
  ).toLowerCase();

  const toleratedGenericMime =
    !suppliedMime ||
    suppliedMime === "application/octet-stream";

  if (
    !toleratedGenericMime &&
    suppliedMime !== definition.mime
  ) {
    throw new HttpError(
      415,
      "The file extension and content type do not match.",
      "MIME_TYPE_MISMATCH"
    );
  }

  return {
    originalFileName,
    safeFileName:
      safeStorageFileName(originalFileName),
    extension,
    mimeType: definition.mime,
    fileSizeBytes,
    displayMode: definition.displayMode,
    defaultCategory: definition.category,
  };
}

function validateExternalUrl(value) {
  const rawUrl = cleanText(value, 4000);

  if (!rawUrl) {
    throw new HttpError(
      400,
      "A Google Drive or external resource URL is required.",
      "URL_REQUIRED"
    );
  }

  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(
      400,
      "The resource URL is not valid.",
      "INVALID_URL"
    );
  }

  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw new HttpError(
      400,
      "Only HTTP and HTTPS resource links are supported.",
      "UNSUPPORTED_URL_PROTOCOL"
    );
  }

  return parsed.toString();
}

function verifyAgvSession(
  request,
  response,
  next
) {
  if (!AGV_SESSION_SECRET) {
    return response.status(503).json({
      ok: false,
      error:
        "Verified AGV session authentication is not configured.",
    });
  }

  const token = bearerToken(request);

  if (!token) {
    return response.status(401).json({
      ok: false,
      error:
        "A verified AGV host session is required.",
    });
  }

  try {
    const claims = jwt.verify(
      token,
      AGV_SESSION_SECRET,
      {
        issuer: "agv-subscription-server",
        audience: "agv-platform",
      }
    );

    const email = normalizeEmail(
      claims?.email
    );

    if (
      claims?.tokenType !==
        "agv_host_session" ||
      !claims?.sub ||
      !email
    ) {
      return response.status(403).json({
        ok: false,
        error:
          "The AGV session is not authorized for University Pal resource management.",
      });
    }

    request.agvSession = {
      sub: cleanText(claims.sub, 500),
      email,
      role: cleanText(
        claims.role || "owner",
        80
      ).toLowerCase(),
      plan: cleanText(
        claims.plan || "FREE",
        80
      ).toUpperCase(),
    };

    return next();
  } catch {
    return response.status(401).json({
      ok: false,
      error:
        "The AGV host session is invalid or expired. Sign in to AGV again.",
    });
  }
}

const rateWindows = new Map();

function requestRateLimit(
  name,
  maximum,
  windowMilliseconds
) {
  return function rateLimitMiddleware(
    request,
    response,
    next
  ) {
    const key = [
      name,
      request.ip || "unknown",
    ].join(":");

    const now = Date.now();

    let holder = rateWindows.get(key);

    if (
      !holder ||
      now >= holder.resetAt
    ) {
      holder = {
        count: 0,
        resetAt:
          now + windowMilliseconds,
      };
    }

    holder.count += 1;
    rateWindows.set(key, holder);

    if (holder.count > maximum) {
      return response.status(429).json({
        ok: false,
        error:
          "Too many University Pal resource requests. Please wait and try again.",
      });
    }

    return next();
  };
}

const corsOptions = {
  origin(origin, callback) {
    if (
      !origin ||
      ALLOWED_ORIGINS.has(origin)
    ) {
      callback(null, true);
      return;
    }

    callback(
      new HttpError(
        403,
        "This website is not approved to use the AGV University Pal resource service.",
        "ORIGIN_NOT_ALLOWED"
      )
    );
  },

  methods: [
    "GET",
    "POST",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  credentials: false,
};

app.disable("x-powered-by");

app.use(cors(corsOptions));

app.options(
  "*",
  cors(corsOptions)
);

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use(
  "/api/university-pal/resources",
  requestRateLimit(
    "university-pal-resources",
    240,
    15 * 60 * 1000
  )
);

function requireConfigured() {
  if (!configured || !supabaseAdmin) {
    throw new HttpError(
      503,
      "The University Pal resource service is not fully configured.",
      "SERVICE_NOT_CONFIGURED"
    );
  }
}

async function ensureStorageBucket() {
  requireConfigured();

  const listResult =
    await supabaseAdmin.storage.listBuckets();

  if (listResult.error) {
    throw listResult.error;
  }

  const existingBucket = (
    listResult.data || []
  ).find(
    (bucket) =>
      bucket.id === STORAGE_BUCKET ||
      bucket.name === STORAGE_BUCKET
  );

  if (existingBucket) {
    if (existingBucket.public === true) {
      throw new Error(
        "Security stop: University Pal resource bucket must not be public."
      );
    }

    return existingBucket;
  }

  const createResult =
    await supabaseAdmin.storage.createBucket(
      STORAGE_BUCKET,
      {
        public: false,
        allowedMimeTypes:
          ALLOWED_MIME_TYPES,
      }
    );

  if (createResult.error) {
    throw createResult.error;
  }

  return createResult.data;
}

async function getHandout(
  publicToken,
  options = {}
) {
  requireConfigured();

  const cleanPublicToken =
    cleanUuid(publicToken);

  if (!cleanPublicToken) {
    throw new HttpError(
      400,
      "A valid student handout token is required.",
      "INVALID_HANDOUT_TOKEN"
    );
  }

  const result = await supabaseAdmin
    .from(HANDOUT_TABLE)
    .select(
      [
        "id",
        "public_token",
        "edit_token_hash",
        "course_name",
        "handout_title",
        "is_published",
        "expires_at",
        "updated_at",
      ].join(",")
    )
    .eq(
      "public_token",
      cleanPublicToken
    )
    .maybeSingle();

  if (result.error) {
    throw result.error;
  }

  if (!result.data) {
    throw new HttpError(
      404,
      "The student handout was not found.",
      "HANDOUT_NOT_FOUND"
    );
  }

  if (options.requirePublished) {
    const expired = Boolean(
      result.data.expires_at &&
      new Date(
        result.data.expires_at
      ).getTime() <= Date.now()
    );

    if (
      result.data.is_published !== true ||
      expired
    ) {
      throw new HttpError(
        404,
        "The student handout is unpublished, expired, or unavailable.",
        "HANDOUT_UNAVAILABLE"
      );
    }
  }

  return result.data;
}

async function authorizeHandoutEdit(
  publicToken,
  editToken
) {
  const cleanEditToken =
    cleanText(editToken, 500);

  if (cleanEditToken.length < 24) {
    throw new HttpError(
      403,
      "A valid private handout edit token is required.",
      "EDIT_TOKEN_REQUIRED"
    );
  }

  const handout = await getHandout(
    publicToken
  );

  const suppliedHash =
    sha256(cleanEditToken);

  if (
    !timingSafeTextEqual(
      suppliedHash,
      handout.edit_token_hash
    )
  ) {
    throw new HttpError(
      403,
      "The private handout edit token is invalid.",
      "INVALID_EDIT_TOKEN"
    );
  }

  return handout;
}

function buildStoragePath(
  handoutId,
  safeFileName
) {
  const now = new Date();

  const year = String(
    now.getUTCFullYear()
  );

  const month = String(
    now.getUTCMonth() + 1
  ).padStart(2, "0");

  const resourceId =
    crypto.randomUUID();

  return {
    resourceId,
    storagePath: [
      cleanUuid(handoutId),
      year,
      month,
      resourceId +
        "-" +
        safeFileName,
    ].join("/"),
  };
}

function signUploadTicket(payload) {
  if (!RESOURCE_TICKET_SECRET) {
    throw new HttpError(
      503,
      "Resource upload tickets are not configured.",
      "UPLOAD_TICKET_NOT_CONFIGURED"
    );
  }

  return jwt.sign(
    {
      ...payload,
      tokenType:
        "agv_up_resource_upload",
    },
    RESOURCE_TICKET_SECRET,
    {
      expiresIn: "2h",
      issuer:
        "agv-university-pal-resource-server",
      audience:
        "agv-university-pal-resource-upload",
    }
  );
}

function verifyUploadTicket(token) {
  const cleanToken =
    cleanText(token, 50000);

  if (!cleanToken) {
    throw new HttpError(
      400,
      "A resource upload completion ticket is required.",
      "UPLOAD_TICKET_REQUIRED"
    );
  }

  try {
    const claims = jwt.verify(
      cleanToken,
      RESOURCE_TICKET_SECRET,
      {
        issuer:
          "agv-university-pal-resource-server",
        audience:
          "agv-university-pal-resource-upload",
      }
    );

    if (
      claims?.tokenType !==
      "agv_up_resource_upload"
    ) {
      throw new Error(
        "Wrong ticket type."
      );
    }

    return claims;
  } catch {
    throw new HttpError(
      401,
      "The resource upload ticket is invalid or expired.",
      "INVALID_UPLOAD_TICKET"
    );
  }
}

async function createReadUrl(resource) {
  if (
    resource.resource_kind ===
    "external_link"
  ) {
    return resource.external_url;
  }

  const options =
    resource.display_mode === "download"
      ? {
          download:
            resource.original_file_name ||
            true,
        }
      : undefined;

  const signedResult =
    await supabaseAdmin.storage
      .from(resource.storage_bucket)
      .createSignedUrl(
        resource.storage_path,
        READ_URL_TTL_SECONDS,
        options
      );

  if (signedResult.error) {
    throw signedResult.error;
  }

  return signedResult.data?.signedUrl || "";
}

async function serializeResource(resource) {
  return {
    id: resource.id,
    resourceKind:
      resource.resource_kind,
    title: resource.title,
    description:
      resource.description || "",
    category: resource.category,
    displayMode:
      resource.display_mode,
    originalFileName:
      resource.original_file_name || "",
    mimeType:
      resource.mime_type || "",
    fileExtension:
      resource.file_extension || "",
    fileSizeBytes:
      Number(
        resource.file_size_bytes || 0
      ),
    externalUrl:
      resource.external_url || "",
    sortOrder:
      Number(resource.sort_order || 0),
    isVisible:
      resource.is_visible === true,
    createdAt:
      resource.created_at || "",
    updatedAt:
      resource.updated_at || "",
    accessUrl:
      await createReadUrl(resource),
    accessUrlExpiresIn:
      resource.resource_kind === "file"
        ? READ_URL_TTL_SECONDS
        : null,
  };
}

async function listResources(
  handoutId,
  includeHidden
) {
  let query = supabaseAdmin
    .from(RESOURCE_TABLE)
    .select("*")
    .eq("handout_id", handoutId)
    .order("sort_order", {
      ascending: true,
    })
    .order("created_at", {
      ascending: true,
    });

  if (!includeHidden) {
    query = query.eq(
      "is_visible",
      true
    );
  }

  const result = await query;

  if (result.error) {
    throw result.error;
  }

  return Promise.all(
    (result.data || []).map(
      serializeResource
    )
  );
}

app.get("/", (request, response) => {
  response.json({
    ok: true,
    service:
      "AGV University Pal Resource Server",
    pass: PASS,
    health:
      "/health",
  });
});

app.get("/health", (request, response) => {
  response.json({
    ok:
      configured &&
      storageBucketReady,
    service:
      "AGV University Pal Resource Server",
    status:
      configured &&
      storageBucketReady
        ? "online"
        : "configuration-required",
    pass: PASS,
    port: PORT,
    supabaseConfigured:
      Boolean(
        SUPABASE_URL &&
        SUPABASE_SERVICE_ROLE_KEY
      ),
    agvSessionConfigured:
      Boolean(AGV_SESSION_SECRET),
    uploadTicketConfigured:
      Boolean(
        RESOURCE_TICKET_SECRET
      ),
    storageBucket:
      STORAGE_BUCKET,
    storageBucketReady,
    storageBootstrapError:
      storageBootstrapError || null,
    maxUploadBytes:
      MAX_UPLOAD_BYTES,
    supportedExtensions:
      Object.keys(FILE_TYPES),
    signedUploads: true,
    privateStorage: true,
    directServiceRoleExposure: false,
  });
});

app.get(
  "/api/university-pal/resources/public/:publicToken",
  asyncRoute(async (request, response) => {
    const handout = await getHandout(
      request.params.publicToken,
      {
        requirePublished: true,
      }
    );

    const resources =
      await listResources(
        handout.id,
        false
      );

    response.json({
      ok: true,
      publicToken:
        handout.public_token,
      courseName:
        handout.course_name,
      handoutTitle:
        handout.handout_title,
      resources,
    });
  })
);

app.post(
  "/api/university-pal/resources/manage/list",
  verifyAgvSession,
  asyncRoute(async (request, response) => {
    const handout =
      await authorizeHandoutEdit(
        request.body?.publicToken,
        request.body?.editToken
      );

    const resources =
      await listResources(
        handout.id,
        true
      );

    response.json({
      ok: true,
      handoutId: handout.id,
      resources,
      session: {
        email:
          request.agvSession.email,
        role:
          request.agvSession.role,
      },
    });
  })
);

app.post(
  "/api/university-pal/resources/upload-ticket",
  verifyAgvSession,
  requestRateLimit(
    "university-pal-upload-ticket",
    60,
    60 * 60 * 1000
  ),
  asyncRoute(async (request, response) => {
    const handout =
      await authorizeHandoutEdit(
        request.body?.publicToken,
        request.body?.editToken
      );

    const file =
      validateFileMetadata(
        request.body?.file || {}
      );

    const storage =
      buildStoragePath(
        handout.id,
        file.safeFileName
      );

    const title =
      cleanText(
        request.body?.title ||
        path.basename(
          file.originalFileName,
          file.extension
        ),
        240
      );

    const description =
      cleanText(
        request.body?.description,
        4000
      );

    const category =
      cleanText(
        request.body?.category ||
        file.defaultCategory,
        120
      );

    const requestedDisplayMode =
      cleanText(
        request.body?.displayMode,
        40
      ).toLowerCase();

    const displayMode = [
      "download",
      "inline",
      "video",
    ].includes(
      requestedDisplayMode
    )
      ? requestedDisplayMode
      : file.displayMode;

    const signedUpload =
      await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .createSignedUploadUrl(
          storage.storagePath,
          {
            upsert: false,
          }
        );

    if (signedUpload.error) {
      throw signedUpload.error;
    }

    const uploadTicket =
      signUploadTicket({
        resourceId:
          storage.resourceId,
        handoutId:
          handout.id,
        publicToken:
          handout.public_token,
        email:
          request.agvSession.email,
        storageBucket:
          STORAGE_BUCKET,
        storagePath:
          storage.storagePath,
        originalFileName:
          file.originalFileName,
        mimeType:
          file.mimeType,
        fileExtension:
          file.extension,
        fileSizeBytes:
          file.fileSizeBytes,
        title,
        description,
        category,
        displayMode,
      });

    response.status(201).json({
      ok: true,
      resourceId:
        storage.resourceId,
      bucket:
        STORAGE_BUCKET,
      path:
        storage.storagePath,
      uploadToken:
        signedUpload.data?.token,
      signedUploadUrl:
        signedUpload.data?.signedUrl,
      uploadTicket,
      mimeType:
        file.mimeType,
      fileSizeBytes:
        file.fileSizeBytes,
      recommendedUploadMode:
        file.fileSizeBytes > 6291456
          ? "resumable"
          : "standard",
      expiresIn: "2h",
    });
  })
);

app.post(
  "/api/university-pal/resources/complete-upload",
  verifyAgvSession,
  asyncRoute(async (request, response) => {
    const ticket =
      verifyUploadTicket(
        request.body?.uploadTicket
      );

    if (
      normalizeEmail(ticket.email) !==
      request.agvSession.email
    ) {
      throw new HttpError(
        403,
        "The upload ticket belongs to another AGV session.",
        "SESSION_TICKET_MISMATCH"
      );
    }

    const handout =
      await authorizeHandoutEdit(
        ticket.publicToken,
        request.body?.editToken
      );

    if (
      cleanUuid(ticket.handoutId) !==
      cleanUuid(handout.id)
    ) {
      throw new HttpError(
        403,
        "The resource does not belong to this student handout.",
        "HANDOUT_TICKET_MISMATCH"
      );
    }

    const existsResult =
      await supabaseAdmin.storage
        .from(ticket.storageBucket)
        .exists(ticket.storagePath);

    if (
      existsResult.error ||
      existsResult.data !== true
    ) {
      throw new HttpError(
        409,
        "The uploaded file was not found in protected storage. Complete the upload before saving the resource.",
        "UPLOAD_NOT_FOUND"
      );
    }

    const payload = {
      id:
        cleanUuid(ticket.resourceId),
      handout_id:
        cleanUuid(ticket.handoutId),
      resource_kind:
        "file",
      title:
        cleanText(ticket.title, 240),
      description:
        cleanText(
          ticket.description,
          4000
        ) || null,
      category:
        cleanText(
          ticket.category ||
          "Reference Material",
          120
        ),
      display_mode:
        cleanText(
          ticket.displayMode ||
          "download",
          40
        ),
      storage_bucket:
        cleanText(
          ticket.storageBucket,
          180
        ),
      storage_path:
        cleanText(
          ticket.storagePath,
          1000
        ),
      external_url:
        null,
      original_file_name:
        cleanText(
          ticket.originalFileName,
          240
        ),
      mime_type:
        cleanText(
          ticket.mimeType,
          180
        ),
      file_extension:
        cleanText(
          ticket.fileExtension,
          20
        ),
      file_size_bytes:
        Number(
          ticket.fileSizeBytes || 0
        ),
      sort_order:
        integerValue(
          request.body?.sortOrder,
          0
        ),
      is_visible:
        booleanValue(
          request.body?.isVisible,
          true
        ),
    };

    const saveResult =
      await supabaseAdmin
        .from(RESOURCE_TABLE)
        .upsert(payload, {
          onConflict: "id",
        })
        .select("*")
        .single();

    if (saveResult.error) {
      throw saveResult.error;
    }

    response.status(201).json({
      ok: true,
      resource:
        await serializeResource(
          saveResult.data
        ),
    });
  })
);

app.post(
  "/api/university-pal/resources/external",
  verifyAgvSession,
  asyncRoute(async (request, response) => {
    const handout =
      await authorizeHandoutEdit(
        request.body?.publicToken,
        request.body?.editToken
      );

    const externalUrl =
      validateExternalUrl(
        request.body?.externalUrl
      );

    const title =
      cleanText(
        request.body?.title,
        240
      );

    if (!title) {
      throw new HttpError(
        400,
        "A resource title is required.",
        "TITLE_REQUIRED"
      );
    }

    const payload = {
      id: crypto.randomUUID(),
      handout_id: handout.id,
      resource_kind:
        "external_link",
      title,
      description:
        cleanText(
          request.body?.description,
          4000
        ) || null,
      category:
        cleanText(
          request.body?.category ||
          "External Resource",
          120
        ),
      display_mode:
        "external",
      storage_bucket:
        null,
      storage_path:
        null,
      external_url:
        externalUrl,
      original_file_name:
        null,
      mime_type:
        null,
      file_extension:
        null,
      file_size_bytes:
        null,
      sort_order:
        integerValue(
          request.body?.sortOrder,
          0
        ),
      is_visible:
        booleanValue(
          request.body?.isVisible,
          true
        ),
    };

    const result =
      await supabaseAdmin
        .from(RESOURCE_TABLE)
        .insert(payload)
        .select("*")
        .single();

    if (result.error) {
      throw result.error;
    }

    response.status(201).json({
      ok: true,
      resource:
        await serializeResource(
          result.data
        ),
    });
  })
);

app.patch(
  "/api/university-pal/resources/:resourceId",
  verifyAgvSession,
  asyncRoute(async (request, response) => {
    const handout =
      await authorizeHandoutEdit(
        request.body?.publicToken,
        request.body?.editToken
      );

    const resourceId =
      cleanUuid(
        request.params.resourceId
      );

    if (!resourceId) {
      throw new HttpError(
        400,
        "A valid resource ID is required.",
        "INVALID_RESOURCE_ID"
      );
    }

    const changes = {};

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "title"
      )
    ) {
      const title =
        cleanText(
          request.body.title,
          240
        );

      if (!title) {
        throw new HttpError(
          400,
          "The resource title cannot be blank.",
          "TITLE_REQUIRED"
        );
      }

      changes.title = title;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "description"
      )
    ) {
      changes.description =
        cleanText(
          request.body.description,
          4000
        ) || null;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "category"
      )
    ) {
      changes.category =
        cleanText(
          request.body.category ||
          "Reference Material",
          120
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "sortOrder"
      )
    ) {
      changes.sort_order =
        integerValue(
          request.body.sortOrder,
          0
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "isVisible"
      )
    ) {
      changes.is_visible =
        booleanValue(
          request.body.isVisible,
          true
        );
    }

    if (
      Object.prototype.hasOwnProperty.call(
        request.body || {},
        "displayMode"
      )
    ) {
      const displayMode =
        cleanText(
          request.body.displayMode,
          40
        ).toLowerCase();

      if (
        ![
          "download",
          "inline",
          "video",
          "external",
        ].includes(displayMode)
      ) {
        throw new HttpError(
          400,
          "The resource display mode is invalid.",
          "INVALID_DISPLAY_MODE"
        );
      }

      changes.display_mode =
        displayMode;
    }

    if (!Object.keys(changes).length) {
      throw new HttpError(
        400,
        "No resource changes were supplied.",
        "NO_CHANGES"
      );
    }

    const result =
      await supabaseAdmin
        .from(RESOURCE_TABLE)
        .update(changes)
        .eq("id", resourceId)
        .eq(
          "handout_id",
          handout.id
        )
        .select("*")
        .maybeSingle();

    if (result.error) {
      throw result.error;
    }

    if (!result.data) {
      throw new HttpError(
        404,
        "The student resource was not found.",
        "RESOURCE_NOT_FOUND"
      );
    }

    response.json({
      ok: true,
      resource:
        await serializeResource(
          result.data
        ),
    });
  })
);

app.delete(
  "/api/university-pal/resources/:resourceId",
  verifyAgvSession,
  asyncRoute(async (request, response) => {
    const handout =
      await authorizeHandoutEdit(
        request.body?.publicToken,
        request.body?.editToken
      );

    const resourceId =
      cleanUuid(
        request.params.resourceId
      );

    if (!resourceId) {
      throw new HttpError(
        400,
        "A valid resource ID is required.",
        "INVALID_RESOURCE_ID"
      );
    }

    const lookup =
      await supabaseAdmin
        .from(RESOURCE_TABLE)
        .select("*")
        .eq("id", resourceId)
        .eq(
          "handout_id",
          handout.id
        )
        .maybeSingle();

    if (lookup.error) {
      throw lookup.error;
    }

    if (!lookup.data) {
      throw new HttpError(
        404,
        "The student resource was not found.",
        "RESOURCE_NOT_FOUND"
      );
    }

    if (
      lookup.data.resource_kind ===
        "file" &&
      lookup.data.storage_bucket &&
      lookup.data.storage_path
    ) {
      const removal =
        await supabaseAdmin.storage
          .from(
            lookup.data.storage_bucket
          )
          .remove([
            lookup.data.storage_path,
          ]);

      if (removal.error) {
        throw removal.error;
      }
    }

    const deleteResult =
      await supabaseAdmin
        .from(RESOURCE_TABLE)
        .delete()
        .eq("id", resourceId)
        .eq(
          "handout_id",
          handout.id
        );

    if (deleteResult.error) {
      throw deleteResult.error;
    }

    response.json({
      ok: true,
      deletedResourceId:
        resourceId,
    });
  })
);

app.use(
  (
    error,
    request,
    response,
    next
  ) => {
    void next;

    const status =
      error instanceof HttpError
        ? error.status
        : 500;

    const safeMessage =
      error instanceof HttpError
        ? error.message
        : "The University Pal resource service could not complete the request.";

    if (status >= 500) {
      console.error(
        "[AGV UP RESOURCE ERROR]",
        error?.message ||
        error
      );
    }

    response.status(status).json({
      ok: false,
      error: safeMessage,
      code:
        error instanceof HttpError
          ? error.code || null
          : "RESOURCE_SERVICE_ERROR",
    });
  }
);

async function bootstrapStorage() {
  if (!configured) {
    storageBootstrapError =
      "Required SERVER environment variables are missing.";

    return;
  }

  try {
    await ensureStorageBucket();

    storageBucketReady = true;
    storageBootstrapError = "";
  } catch (error) {
    storageBucketReady = false;

    storageBootstrapError =
      cleanText(
        error?.message ||
        String(error),
        1000
      );

    console.error(
      "[AGV UP STORAGE BOOTSTRAP]",
      storageBootstrapError
    );
  }
}

const server = app.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "AGV University Pal Resource Server"
    );
    console.log(
      "Pass:",
      PASS
    );
    console.log(
      "Listening:",
      `http://${HOST}:${PORT}`
    );
    console.log(
      "Health:",
      `http://127.0.0.1:${PORT}/health`
    );
    console.log(
      "Private bucket:",
      STORAGE_BUCKET
    );
    console.log("");
  }
);

bootstrapStorage();

function shutdown(signal) {
  console.log(
    `\n${signal}: stopping University Pal Resource Server.`
  );

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);