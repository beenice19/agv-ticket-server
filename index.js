require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const { Server } = require("socket.io");
const {
  loadMediaRegistrySnapshot,
  queueMediaRegistrySnapshot,
  getMediaRegistryAdapterStatus,
} = require("./agv-media-registry-supabase.cjs");

const app = express();
const PORT = Number(process.env.PORT || 8787); // PASS_LIVE_SERVICE_DEPLOY_MAP_1_RENDER_PORT

const AGV_MEDIA_REGISTRY_MODE = String(
  process.env.AGV_MEDIA_REGISTRY_MODE || "file"
).trim().toLowerCase();

const AGV_MEDIA_REGISTRY_SUPABASE_ENABLED =
  AGV_MEDIA_REGISTRY_MODE === "supabase";

app.use(cors());
app.use(express.json({ limit: "8mb" }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PRESENCE_STALE_MS = 45000;
const PRESENCE_SWEEP_MS = 15000;

const DATA_FILE = path.join(__dirname, "stro-cheivery-data.json");
const USERS_FILE = path.join(__dirname, "stro-cheivery-users.json");
const MEDIA_INTAKE_FILE = path.join(__dirname, "stro-cheivery-media-intake.json");

// PASS PROD-OD-01 — HOSTED PUBLIC MEDIA SNAPSHOT
const PUBLIC_MEDIA_CATALOG_FILE = path.join(__dirname, "stro-cheivery-public-media-catalog.json");

// PASS CP-03 CONTENT PARTNER SUBMISSION DRAFT REGISTRY
const CONTENT_PARTNER_SUBMISSIONS_FILE = path.join(
  __dirname,
  "stro-cheivery-content-partner-submissions.json"
);

// PASS CP-07 SECURE PARTNER FEATURE FILM UPLOAD
// Partner-token upload into the existing Owner-private controlled storage area.
// No approval, public playback, or publication is created by this route.
app.post(
  "/api/content-partner/submissions/:submissionId/upload-feature",
  (req, res) => {
    const submissionId = cleanContentPartnerText(
      req.params?.submissionId,
      100
    );

    if (!/^AGV-CP-[A-Z0-9-]+$/i.test(submissionId)) {
      return res.status(400).json({
        ok: false,
        error: "A valid partner submission ID is required",
      });
    }

    const draftAccessToken =
      readContentPartnerDraftToken(req);

    if (!draftAccessToken) {
      return res.status(401).json({
        ok: false,
        error:
          "The private partner draft access token is required",
      });
    }

    const submissions =
      loadContentPartnerSubmissions();

    const submission = submissions.find(
      (entry) => entry.submissionId === submissionId
    );

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: "Partner submission was not found",
      });
    }

    const suppliedHash =
      hashContentPartnerDraftToken(draftAccessToken);

    const storedHash = String(
      submission.draftAccessTokenHash || ""
    );

    const suppliedBuffer = Buffer.from(
      suppliedHash,
      "hex"
    );

    const storedBuffer = Buffer.from(
      storedHash,
      "hex"
    );

    const tokenMatches =
      suppliedBuffer.length === storedBuffer.length &&
      suppliedBuffer.length > 0 &&
      crypto.timingSafeEqual(
        suppliedBuffer,
        storedBuffer
      );

    if (!tokenMatches) {
      return res.status(403).json({
        ok: false,
        error: "The partner draft access token is invalid",
      });
    }

    const intakeId = cleanContentPartnerText(
      submission?.upload?.mediaIntakeId,
      100
    );

    if (!/^AGV-CU-[A-Z0-9-]+$/i.test(intakeId)) {
      return res.status(409).json({
        ok: false,
        error:
          "A secure media intake must be reserved before feature upload",
      });
    }

    if (
      submission.status !== "AWAITING_SECURE_UPLOAD"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "This Partner submission is not awaiting secure upload",
        status: submission.status,
      });
    }

    const mediaIntakes = loadMediaIntakes();

    const intake = mediaIntakes.find(
      (entry) => entry.intakeId === intakeId
    );

    if (!intake) {
      return res.status(404).json({
        ok: false,
        error:
          "The linked controlled media intake was not found",
      });
    }

    if (
      intake.partnerSubmissionId !== submissionId ||
      intake.source !== "AGV_CONTENT_PARTNER_PORTAL"
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "This controlled media intake does not belong to the Partner submission",
      });
    }

    if (intake.status !== "AWAITING_SECURE_UPLOAD") {
      return res.status(409).json({
        ok: false,
        error:
          "The linked intake is no longer awaiting upload",
        status: intake.status,
      });
    }

    if (
      intake.visibility !== "OWNER_PRIVATE_REVIEW" ||
      intake.publicAccess === true
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "The linked intake is not configured for Owner-private review",
      });
    }

    req.controlledMediaIntakeId = intakeId;

    controlledMediaUpload.single("media")(
      req,
      res,
      (uploadError) => {
        if (uploadError) {
          removeControlledUploadFile(req.file?.path);

          const isSizeError =
            uploadError?.code === "LIMIT_FILE_SIZE";

          return res.status(
            isSizeError ? 413 : 400
          ).json({
            ok: false,
            error: isSizeError
              ? "The selected feature film exceeds the upload limit"
              : uploadError?.message ||
                "The secure Partner feature upload failed",
          });
        }

        if (!req.file) {
          return res.status(400).json({
            ok: false,
            error:
              'A feature-film file is required in multipart field "media"',
          });
        }

        const currentSubmissions =
          loadContentPartnerSubmissions();

        const currentSubmissionIndex =
          currentSubmissions.findIndex(
            (entry) =>
              entry.submissionId === submissionId
          );

        const currentMediaIntakes =
          loadMediaIntakes();

        const currentIntakeIndex =
          currentMediaIntakes.findIndex(
            (entry) => entry.intakeId === intakeId
          );

        if (
          currentSubmissionIndex < 0 ||
          currentIntakeIndex < 0
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(404).json({
            ok: false,
            error:
              "The Partner submission or controlled intake was not found after upload",
          });
        }

        const currentSubmission =
          currentSubmissions[currentSubmissionIndex];

        const currentIntake =
          currentMediaIntakes[currentIntakeIndex];

        if (
          currentSubmission.status !==
            "AWAITING_SECURE_UPLOAD" ||
          currentIntake.status !==
            "AWAITING_SECURE_UPLOAD"
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(409).json({
            ok: false,
            error:
              "The Partner submission or intake changed before the upload completed",
          });
        }

        if (
          currentSubmission?.upload?.mediaIntakeId !==
            intakeId ||
          currentIntake.partnerSubmissionId !==
            submissionId
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(403).json({
            ok: false,
            error:
              "The Partner submission and media intake linkage could not be verified",
          });
        }

        const expectedName = path.basename(
          String(currentIntake.filename || "")
        );

        const receivedName = path.basename(
          String(req.file.originalname || "")
        );

        const expectedSize = Number(
          currentIntake.filesize
        );

        const receivedSize = Number(req.file.size);

        if (
          !expectedName ||
          expectedName !== receivedName ||
          !Number.isSafeInteger(receivedSize) ||
          receivedSize < 1 ||
          expectedSize !== receivedSize
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(409).json({
            ok: false,
            error:
              "The uploaded feature film does not match the reserved filename and byte size",
          });
        }

        const expectedExtension = path
          .extname(expectedName)
          .toLowerCase();

        const receivedExtension = path
          .extname(receivedName)
          .toLowerCase();

        if (
          expectedExtension !== receivedExtension ||
          !CONTROLLED_MEDIA_EXTENSIONS.has(
            receivedExtension
          )
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(409).json({
            ok: false,
            error:
              "The uploaded feature-film extension does not match the reservation",
          });
        }

        const now = new Date().toISOString();

        const updatedIntake = {
          ...currentIntake,
          status: "UPLOADED_PENDING_REVIEW",
          updatedAt: now,
          uploadedAt: now,
          visibility: "OWNER_PRIVATE_REVIEW",
          publicAccess: false,

          partnerControls: {
            ...(currentIntake.partnerControls || {}),
            reservationAuthorized: true,
            partnerUploadEnabled: false,
            featureUploadCompleted: true,
            founderReviewRequired: true,
          },

          upload: {
            originalFilename: receivedName,

            storedFilename: path.basename(
              req.file.filename
            ),

            storageArea:
              "CONTROLLED_MEDIA_UPLOAD_DIR",

            relativePath: path.relative(
              __dirname,
              req.file.path
            ),

            filesize: receivedSize,

            mimetype: cleanMediaIntakeText(
              req.file.mimetype ||
                currentIntake.mimetype ||
                "application/octet-stream",
              150
            ),

            uploadedAt: now,

            uploadedBy: {
              username: cleanMediaIntakeText(
                currentSubmission?.partner
                  ?.contactEmail,
                150
              ),

              displayName: cleanMediaIntakeText(
                currentSubmission?.partner
                  ?.contactName,
                200
              ),

              globalRole: "content_partner",
            },
          },
        };

        const updatedSubmission = {
          ...currentSubmission,
          status:
            "UPLOADED_AWAITING_FOUNDER_REVIEW",
          updatedAt: now,

          upload: {
            ...(currentSubmission.upload || {}),
            enabled: false,
            partnerUploadEnabled: false,
            mediaIntakeId: intakeId,
            uploadedAt: now,
            originalFilename: receivedName,
            filesize: receivedSize,
            mimetype: updatedIntake.upload.mimetype,
            storageStatus: "OWNER_PRIVATE",
          },

          review: {
            ...(currentSubmission.review || {}),
            rightsCheck:
              currentSubmission?.review?.rightsCheck ||
              "NOT_STARTED",
            technicalReview: "READY_FOR_REVIEW",
            editorialReview:
              currentSubmission?.review
                ?.editorialReview ||
              "NOT_STARTED",
            approvalStatus: "NOT_STARTED",
            networkPlacement: "NOT_STARTED",
          },

          publication: {
            ...(currentSubmission.publication || {}),
            eligible: false,
            publicAccess: false,
            publishedAt: null,
          },
        };

        currentMediaIntakes[currentIntakeIndex] =
          updatedIntake;

        currentSubmissions[currentSubmissionIndex] =
          updatedSubmission;

        try {
          saveMediaIntakes(currentMediaIntakes);
        } catch (error) {
          removeControlledUploadFile(req.file.path);

          console.error(
            "PARTNER FEATURE INTAKE SAVE FAILED:",
            error.message
          );

          return res.status(500).json({
            ok: false,
            error:
              "The feature film was received but the controlled intake record could not be updated",
          });
        }

        try {
          saveContentPartnerSubmissions(
            currentSubmissions
          );
        } catch (error) {
          removeControlledUploadFile(req.file.path);

          try {
            const rollbackIntakes =
              loadMediaIntakes();

            const rollbackIndex =
              rollbackIntakes.findIndex(
                (entry) => entry.intakeId === intakeId
              );

            if (rollbackIndex >= 0) {
              rollbackIntakes[rollbackIndex] =
                currentIntake;

              saveMediaIntakes(rollbackIntakes);
            }
          } catch (rollbackError) {
            console.error(
              "PARTNER FEATURE UPLOAD REGISTRY ROLLBACK FAILED:",
              rollbackError.message
            );
          }

          console.error(
            "PARTNER FEATURE SUBMISSION SAVE FAILED:",
            error.message
          );

          return res.status(500).json({
            ok: false,
            error:
              "The feature film was received but the Partner submission record could not be updated",
          });
        }

        return res.status(201).json({
          ok: true,
          submissionId,
          partnerStatus: updatedSubmission.status,
          intakeId,
          intakeStatus: updatedIntake.status,

          ownerPrivate: true,
          publicAccess: false,
          founderReviewRequired: true,
          automaticApproval: false,
          automaticPublication: false,

          submission:
            safeContentPartnerSubmission(
              updatedSubmission
            ),

          intake: {
            intakeId: updatedIntake.intakeId,
            status: updatedIntake.status,
            title: updatedIntake.title,
            originalFilename:
              updatedIntake.upload.originalFilename,
            filesize:
              updatedIntake.upload.filesize,
            mimetype:
              updatedIntake.upload.mimetype,
            storageArea:
              updatedIntake.upload.storageArea,
            visibility:
              updatedIntake.visibility,
            publicAccess: false,
          },

          message:
            "Feature film uploaded securely and is awaiting Founder review.",
        });
      }
    );
  }
);

// PASS CU-09A2 SECURE CONTROLLED MEDIA UPLOAD
// Media is stored outside public web folders and is not directly published.
const CONTROLLED_MEDIA_UPLOAD_DIR = path.join(
  __dirname,
  "controlled-media-uploads"
);

const CONTROLLED_MEDIA_MAX_BYTES = Number(
  process.env.AGV_MEDIA_UPLOAD_MAX_BYTES || 2147483648
);

const CONTROLLED_MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".mov",
  ".avi",
  ".webm",
]);

fs.mkdirSync(CONTROLLED_MEDIA_UPLOAD_DIR, {
  recursive: true,
});

// PASS CU-10C FOUNDER PRIVATE PREVIEW STREAMING
// Temporary opaque preview tickets prevent exposing permanent media URLs.
const CONTROLLED_MEDIA_PREVIEW_TICKET_TTL_MS = Number(
  process.env.AGV_MEDIA_PREVIEW_TICKET_TTL_MS || 300000
);

const controlledMediaPreviewTickets = new Map();
const JWT_SECRET =
  process.env.AGV_JWT_SECRET || "agv-dev-secret-change-this-before-production";
const JWT_EXPIRES_IN = "7d";

// PASS CU-08I-V2 VERIFIED OWNER SESSION COMPATIBILITY
// Used only by the controlled media-intake authorization middleware.
const AGV_SESSION_SECRET = String(
  process.env.AGV_SESSION_SECRET || ""
).trim();

const AGV_SUPER_ADMIN_EMAILS = new Set(
  String(process.env.AGV_SUPER_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);

const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_DISPLAY_NAME = "Admin";
const DEFAULT_ADMIN_PASSWORD =
  process.env.AGV_ADMIN_PASSWORD || "CHANGE_THIS_ADMIN_PASSWORD_NOW";

const DEFAULT_ROOMS = [
  {
    id: "main-hall",
    name: "Main Hall",
    category: "Convention",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: ["Admin"],
  },
  {
    id: "studio-a",
    name: "Studio A",
    category: "Media",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "radio-room",
    name: "Radio Room",
    category: "Broadcast",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "prayer-room",
    name: "Prayer Room",
    category: "Community",
    isPrivate: true,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "classroom-1",
    name: "Classroom 1",
    category: "Teaching",
    isPrivate: false,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
  {
    id: "green-room",
    name: "Green Room",
    category: "Backstage",
    isPrivate: true,
    isLocked: false,
    assignedHost: "Admin",
    moderators: [],
  },
];

const DEFAULT_ROOM_STATE = {
  "main-hall": {
    messages: [
      {
        id: 1,
        sender: "System",
        text: "Welcome to Avant Global Vision.",
        time: timeNow(),
      },
      {
        id: 2,
        sender: "Admin",
        text: "Main stage is ready.",
        time: timeNow(),
      },
    ],
    bulletins: [
      "Welcome to Avant Global Vision.",
      "Your invited room opens directly after sign-in.",
      "Hosts and moderators manage each room separately.",
    ],
    bulletinSource: "manual",
  },
};

let rooms = [];
let roomState = {};
let users = [];
let presenceByRoom = {};

/*
  SAFE BUILD BROADCAST LAYER

  This stores only signaling state.
  It does NOT store video.
  Video moves browser-to-browser through WebRTC.

  roomBroadcasts shape:
  {
    "main-hall": {
      hostSocketId: "...",
      hostName: "Admin",
      mode: "camera" | "screen",
      startedAt: "..."
    }
  }
*/
const roomBroadcasts = {};

function timeNow() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanName(value) {
  return String(value || "").trim();
}

function uniqueNames(values) {
  const seen = new Set();
  const output = [];

  for (const value of Array.isArray(values) ? values : []) {
    const cleaned = cleanName(value);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    output.push(cleaned);
  }

  return output;
}

function safeUser(user) {
  return {
    username: user.username,
    displayName: user.displayName,
    globalRole: user.globalRole,
    isActive: Boolean(user.isActive),
    createdAt: user.createdAt,
  };
}

function defaultRoomState() {
  return {
    messages: [],
    bulletins: [],
    bulletinSource: "manual",
  };
}

function ensureRoomState(roomId) {
  if (!roomState[roomId]) {
    roomState[roomId] = defaultRoomState();
  }

  if (!Array.isArray(roomState[roomId].messages)) {
    roomState[roomId].messages = [];
  }

  if (!Array.isArray(roomState[roomId].bulletins)) {
    roomState[roomId].bulletins = [];
  }

  if (!roomState[roomId].bulletinSource) {
    roomState[roomId].bulletinSource = "manual";
  }

  return roomState[roomId];
}

function normalizeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    category: room.category,
    isPrivate: Boolean(room.isPrivate),
    isLocked: Boolean(room.isLocked),
    assignedHost: cleanName(room.assignedHost) || "Admin",
    moderators: uniqueNames(room.moderators),
    host: cleanName(room.assignedHost) || "Admin",
  };
}

function sanitizeRoom(input) {
  return normalizeRoom({
    id: cleanName(input.id),
    name: cleanName(input.name),
    category: cleanName(input.category) || "Room",
    isPrivate: Boolean(input.isPrivate),
    isLocked: Boolean(input.isLocked),
    assignedHost: cleanName(input.assignedHost) || "Admin",
    moderators: uniqueNames(input.moderators),
  });
}

function getRoomSnapshot(roomId) {
  const room = findRoom(roomId);
  if (!room) return null;

  return {
    room: normalizeRoom(room),
    state: ensureRoomState(roomId),
    participants: getParticipantsForRoom(roomId),
    broadcast: roomBroadcasts[roomId] || null,
  };
}

function saveData() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ rooms, roomState }, null, 2),
    "utf8"
  );
}

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
}

// PASS CP-03 CONTENT PARTNER SUBMISSION DRAFT REGISTRY
function loadContentPartnerSubmissions() {
  if (!fs.existsSync(CONTENT_PARTNER_SUBMISSIONS_FILE)) {
    fs.writeFileSync(
      CONTENT_PARTNER_SUBMISSIONS_FILE,
      JSON.stringify([], null, 2),
      "utf8"
    );

    return [];
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(CONTENT_PARTNER_SUBMISSIONS_FILE, "utf8")
    );

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(
      "CONTENT PARTNER SUBMISSION LOAD FAILED:",
      error.message
    );

    return [];
  }
}

function saveContentPartnerSubmissions(submissions) {
  const temporaryFile =
    CONTENT_PARTNER_SUBMISSIONS_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(submissions, null, 2),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    CONTENT_PARTNER_SUBMISSIONS_FILE
  );
}

function cleanContentPartnerText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function createContentPartnerSubmissionId(existingSubmissions) {
  let submissionId = "";

  do {
    const timePart = Date.now()
      .toString(36)
      .toUpperCase();

    const randomPart = crypto
      .randomBytes(4)
      .toString("hex")
      .toUpperCase();

    submissionId =
      `AGV-CP-${timePart}-${randomPart}`;
  } while (
    existingSubmissions.some(
      (entry) => entry.submissionId === submissionId
    )
  );

  return submissionId;
}

function createContentPartnerDraftToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashContentPartnerDraftToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""), "utf8")
    .digest("hex");
}

function safeContentPartnerSubmission(submission) {
  if (!submission || typeof submission !== "object") {
    return null;
  }

  const {
    draftAccessTokenHash,
    ...safeSubmission
  } = submission;

  return safeSubmission;
}

function readContentPartnerDraftToken(req) {
  return cleanContentPartnerText(
    req.headers["x-agv-partner-draft-token"],
    200
  );
}

function validateContentPartnerDraftPayload(body) {
  const channelName = cleanContentPartnerText(
    body?.channelName,
    200
  );

  const contactName = cleanContentPartnerText(
    body?.contactName,
    200
  );

  const contactEmail = cleanContentPartnerText(
    body?.contactEmail,
    320
  ).toLowerCase();

  const country = cleanContentPartnerText(
    body?.country,
    150
  );

  const filmTitle = cleanContentPartnerText(
    body?.filmTitle,
    250
  );

  const synopsis = cleanContentPartnerText(
    body?.synopsis,
    4000
  );

  const genre = cleanContentPartnerText(
    body?.genre,
    120
  );

  const validEmail =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail);

  if (!channelName || !contactName || !contactEmail) {
    return {
      ok: false,
      error:
        "Channel name, contact name, and contact email are required",
    };
  }

  if (!validEmail) {
    return {
      ok: false,
      error: "A valid contact email is required",
    };
  }

  if (!country) {
    return {
      ok: false,
      error: "Country or territory is required",
    };
  }

  if (body?.identityConfirmed !== true) {
    return {
      ok: false,
      error:
        "Authorized representative confirmation is required",
    };
  }

  if (!filmTitle || !synopsis || !genre) {
    return {
      ok: false,
      error:
        "Film title, synopsis, and genre are required",
    };
  }

  const rightsComplete =
    body?.ownsFilmRights === true &&
    body?.musicClearance === true &&
    body?.footageClearance === true &&
    body?.talentReleases === true &&
    body?.distributionAuthority === true;

  if (!rightsComplete) {
    return {
      ok: false,
      error:
        "Every rights and ownership declaration is required",
    };
  }

  const featureName = cleanContentPartnerText(
    body?.featureName,
    255
  );

  if (!featureName) {
    return {
      ok: false,
      error: "Feature-film filename is required",
    };
  }

  const releaseType = cleanContentPartnerText(
    body?.releaseType,
    100
  ).toUpperCase();

  const allowedReleaseTypes = new Set([
    "FREE_SCREENING",
    "LIVE_PREMIERE",
    "RENTAL",
    "PURCHASE",
  ]);

  if (!allowedReleaseTypes.has(releaseType)) {
    return {
      ok: false,
      error: "A valid release type is required",
    };
  }

  return {
    ok: true,
    normalized: {
      partner: {
        channelName,
        partnerType:
          cleanContentPartnerText(
            body?.partnerType,
            150
          ) || "Independent Filmmaker",
        contactName,
        contactEmail,
        contactPhone: cleanContentPartnerText(
          body?.contactPhone,
          100
        ),
        organizationName: cleanContentPartnerText(
          body?.organizationName,
          250
        ),
        country,
        identityConfirmed: true,
      },

      film: {
        title: filmTitle,
        synopsis,
        genre,
        runtime: cleanContentPartnerText(
          body?.runtime,
          100
        ),
        audienceRating: cleanContentPartnerText(
          body?.audienceRating,
          100
        ),
        productionYear: cleanContentPartnerText(
          body?.productionYear,
          20
        ),
        language: cleanContentPartnerText(
          body?.language,
          100
        ),
        territoryRights: cleanContentPartnerText(
          body?.territoryRights,
          500
        ),
      },

      rightsDeclarations: {
        ownsFilmRights: true,
        musicClearance: true,
        footageClearance: true,
        talentReleases: true,
        distributionAuthority: true,
      },

      fileMetadata: {
        posterName: cleanContentPartnerText(
          body?.posterName,
          255
        ),
        trailerName: cleanContentPartnerText(
          body?.trailerName,
          255
        ),
        featureName,
        captionsName: cleanContentPartnerText(
          body?.captionsName,
          255
        ),
      },

      releaseSetup: {
        releaseType,
        preferredPremiereDate:
          cleanContentPartnerText(
            body?.preferredPremiereDate,
            40
          ),
        reviewerNotes: cleanContentPartnerText(
          body?.reviewerNotes,
          2000
        ),
      },
    },
  };
}

// PASS CU-07C — CONTROLLED MEDIA INTAKE PERSISTENCE
function loadMediaIntakes() {
  if (!fs.existsSync(MEDIA_INTAKE_FILE)) {
    fs.writeFileSync(MEDIA_INTAKE_FILE, JSON.stringify([], null, 2), "utf8");
    return [];
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(MEDIA_INTAKE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("MEDIA INTAKE LOAD FAILED:", error.message);
    return [];
  }
}

function saveMediaIntakes(mediaIntakes) {
  fs.writeFileSync(
    MEDIA_INTAKE_FILE,
    JSON.stringify(mediaIntakes, null, 2),
    "utf8"
  );

  if (AGV_MEDIA_REGISTRY_SUPABASE_ENABLED) {
    queueMediaRegistrySnapshot(mediaIntakes).catch(
      (error) => {
        console.error(
          "MEDIA REGISTRY SUPABASE SAVE FAILED:",
          error.message
        );
      }
    );
  }
}

// PASS CU-07D — CONTROLLED MEDIA INTAKE HELPERS
function createMediaIntakeId(existingIntakes) {
  let intakeId = "";

  do {
    const timePart = Date.now().toString(36).toUpperCase();
    const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
    intakeId = `AGV-CU-${timePart}-${randomPart}`;
  } while (existingIntakes.some((entry) => entry.intakeId === intakeId));

  return intakeId;
}

function cleanMediaIntakeText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

// PASS CU-09A2 SECURE CONTROLLED MEDIA UPLOAD
function removeControlledUploadFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(
      "CONTROLLED MEDIA CLEANUP FAILED:",
      error.message
    );
  }
}

function requireReservedControlledMediaIntake(req, res, next) {
  const intakeId = cleanMediaIntakeText(
    req.params?.intakeId,
    100
  );

  if (!/^AGV-CU-[A-Z0-9-]+$/i.test(intakeId)) {
    return res.status(400).json({
      ok: false,
      error: "A valid controlled intake ID is required",
    });
  }

  const mediaIntakes = loadMediaIntakes();
  const intake = mediaIntakes.find(
    (entry) => entry.intakeId === intakeId
  );

  if (!intake) {
    return res.status(404).json({
      ok: false,
      error: "Controlled media intake was not found",
    });
  }

  if (intake.status !== "AWAITING_SECURE_UPLOAD") {
    return res.status(409).json({
      ok: false,
      error:
        "This intake is not awaiting a secure upload",
      status: intake.status,
    });
  }

  req.controlledMediaIntakeId = intakeId;
  next();
}

const controlledMediaStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, CONTROLLED_MEDIA_UPLOAD_DIR);
  },

  filename: (req, file, callback) => {
    const originalName = String(file.originalname || "");
    const extension = path
      .extname(originalName)
      .toLowerCase();

    const safeIntakeId = String(
      req.controlledMediaIntakeId || "AGV-CU"
    ).replace(/[^a-zA-Z0-9-]/g, "");

    const randomPart = crypto
      .randomBytes(8)
      .toString("hex");

    callback(
      null,
      `${safeIntakeId}-${Date.now()}-${randomPart}${extension}`
    );
  },
});

const controlledMediaUpload = multer({
  storage: controlledMediaStorage,

  limits: {
    files: 1,
    fileSize: CONTROLLED_MEDIA_MAX_BYTES,
  },

  fileFilter: (req, file, callback) => {
    const extension = path
      .extname(String(file.originalname || ""))
      .toLowerCase();

    if (!CONTROLLED_MEDIA_EXTENSIONS.has(extension)) {
      return callback(
        new Error(
          "Unsupported media file extension"
        )
      );
    }

    callback(null, true);
  },
});

// PASS32D_B_V2_HOST_OWNED_ROOM_CREATION
const ROOM_PLAN_LIMITS = {
  FREE: { label: "Free", hostLabel: "FREE HOST", maxRooms: 1, maxViewers: 25, allowPrivate: false, allowTicketOnly: false },
  CREATOR: { label: "Creator", hostLabel: "CREATOR HOST", maxRooms: 3, maxViewers: 100, allowPrivate: true, allowTicketOnly: true },
  MINISTRY: { label: "Ministry / Pro", hostLabel: "MINISTRY HOST", maxRooms: 10, maxViewers: 500, allowPrivate: true, allowTicketOnly: true },
  CONVENTION: { label: "Convention", hostLabel: "CONVENTION HOST", maxRooms: 50, maxViewers: 2000, allowPrivate: true, allowTicketOnly: true },
};

function cleanRoomText(value) {
  return String(value || "").trim();
}

function normalizeRoomPlan(plan) {
  const cleanPlan = cleanRoomText(plan).toUpperCase();
  if (cleanPlan === "INTERNAL_TEST") return "CREATOR";
  return ROOM_PLAN_LIMITS[cleanPlan] ? cleanPlan : "FREE";
}

function getRoomOwnerIdFromRequest(req) {
  const bodyOwner =
    cleanRoomText(req.body?.ownerId) ||
    cleanRoomText(req.body?.requesterId) ||
    cleanRoomText(req.body?.ownerEmail) ||
    cleanRoomText(req.body?.requesterEmail);

  const authOwner =
    cleanRoomText(req.authUser?.email) ||
    cleanRoomText(req.authUser?.username) ||
    cleanRoomText(req.authUser?.displayName);

  return (bodyOwner || authOwner || "unknown-owner").toLowerCase();
}

function getRoomOwnerEmailFromRequest(req) {
  return (
    cleanRoomText(req.body?.ownerEmail) ||
    cleanRoomText(req.body?.requesterEmail) ||
    cleanRoomText(req.authUser?.email) ||
    cleanRoomText(req.authUser?.username) ||
    ""
  ).toLowerCase();
}

function getRoomOwnerNameFromRequest(req) {
  return (
    cleanRoomText(req.body?.ownerName) ||
    cleanRoomText(req.body?.displayName) ||
    cleanRoomText(req.authUser?.displayName) ||
    cleanRoomText(req.authUser?.username) ||
    "AGV Host"
  );
}

function isRoomSuperAdmin(req) {
  return (
    req.authUser?.globalRole === "superadmin" ||
    cleanRoomText(req.body?.requesterRole).toLowerCase() === "super-admin"
  );
}

function isPlatformRoom(room) {
  if (!room) return false;
  return !(
    cleanRoomText(room.ownerId) ||
    cleanRoomText(room.ownerEmail) ||
    cleanRoomText(room.createdBy)
  );
}

function roomBelongsToOwner(room, ownerId, ownerEmail) {
  if (!room) return false;

  const roomOwnerId = cleanRoomText(room.ownerId || room.createdBy || room.ownerEmail).toLowerCase();
  const roomOwnerEmail = cleanRoomText(room.ownerEmail || room.createdBy).toLowerCase();

  return (
    Boolean(ownerId && roomOwnerId && roomOwnerId === ownerId) ||
    Boolean(ownerEmail && roomOwnerEmail && roomOwnerEmail === ownerEmail)
  );
}

function getOwnedRoomCount(ownerId, ownerEmail) {
  return rooms.filter((room) => {
    if (isPlatformRoom(room)) return false;
    return roomBelongsToOwner(room, ownerId, ownerEmail);
  }).length;
}

function sanitizeOwnedRoom(room) {
  const clean = sanitizeRoom(room);

  return {
    ...clean,
    ownerId: cleanRoomText(room?.ownerId || room?.createdBy),
    ownerEmail: cleanRoomText(room?.ownerEmail).toLowerCase(),
    ownerName: cleanRoomText(room?.ownerName),
    organization: cleanRoomText(room?.organization || room?.ownerOrganization),
    createdBy: cleanRoomText(room?.createdBy || room?.ownerId || room?.ownerEmail),
    createdByPlan: normalizeRoomPlan(room?.createdByPlan || room?.planMode || room?.plan),
    planMode: normalizeRoomPlan(room?.planMode || room?.createdByPlan || room?.plan),
    planLabel: cleanRoomText(room?.planLabel),
    planHostLabel: cleanRoomText(room?.planHostLabel),
    maxRooms: Number(room?.maxRooms || 0),
    maxViewers: Number(room?.maxViewers || 0),
    allowPrivate: Boolean(room?.allowPrivate),
    allowTicketOnly: Boolean(room?.allowTicketOnly),
    createdAt: cleanRoomText(room?.createdAt),
  };
}

function normalizeOwnedRoom(room) {
  return sanitizeOwnedRoom(room);
}

function getVisibleRoomsForUser(req) {
  if (isRoomSuperAdmin(req)) return rooms;

  const ownerId = getRoomOwnerIdFromRequest(req);
  const ownerEmail = getRoomOwnerEmailFromRequest(req);

  return rooms.filter((room) => isPlatformRoom(room) || roomBelongsToOwner(room, ownerId, ownerEmail));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    rooms = DEFAULT_ROOMS.map(sanitizeOwnedRoom);
    roomState = JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));
    saveData();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    rooms = Array.isArray(parsed.rooms)
      ? parsed.rooms.map(sanitizeOwnedRoom)
      : DEFAULT_ROOMS.map(sanitizeOwnedRoom);

    roomState =
      parsed.roomState && typeof parsed.roomState === "object"
        ? parsed.roomState
        : JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));

    for (const room of rooms) {
      ensureRoomState(room.id);
    }
  } catch (error) {
    rooms = DEFAULT_ROOMS.map(sanitizeOwnedRoom);
    roomState = JSON.parse(JSON.stringify(DEFAULT_ROOM_STATE));
    saveData();
  }
}

function seedDefaultAdmin() {
  if (users.some((user) => user.username === DEFAULT_ADMIN_USERNAME)) {
    return;
  }

  const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);

  users.push({
    username: DEFAULT_ADMIN_USERNAME,
    displayName: DEFAULT_ADMIN_DISPLAY_NAME,
    passwordHash,
    globalRole: "superadmin",
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  saveUsers();
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    users = [];
    seedDefaultAdmin();
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    users = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    users = [];
  }

  seedDefaultAdmin();
}

function signToken(user) {
  return jwt.sign(
    {
      username: user.username,
      displayName: user.displayName,
      globalRole: user.globalRole,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

function requireAuth(req, res, next) {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      return res
        .status(401)
        .json({ ok: false, error: "Authentication required" });
    }

    const payload = verifyToken(token);
    const user = users.find((entry) => entry.username === payload.username);

    if (!user || !user.isActive) {
      return res.status(401).json({ ok: false, error: "Invalid user" });
    }

    req.authUser = safeUser(user);
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

function requireSuperadmin(req, res, next) {
  if (!req.authUser || req.authUser.globalRole !== "superadmin") {
    return res.status(403).json({ ok: false, error: "Admin only" });
  }

  next();
}

// PASS CU-08I-V2 VERIFIED OWNER SESSION COMPATIBILITY
// Limited exclusively to the controlled media-intake reservation route.
function requireControlledMediaSuperadmin(req, res, next) {
  const token = getTokenFromRequest(req);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "A verified AGV Super Admin session is required",
    });
  }

  // Preserve support for the existing SERVER 8787 Super Admin token.
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.find(
      (entry) => entry.username === payload.username
    );

    if (
      user &&
      user.isActive &&
      user.globalRole === "superadmin"
    ) {
      req.authUser = safeUser(user);
      return next();
    }
  } catch {}

  // Verify the existing SERVER 8792 AGV Owner/Admin session.
  if (!AGV_SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      error: "Verified AGV session authentication is not configured",
    });
  }

  if (!AGV_SUPER_ADMIN_EMAILS.size) {
    return res.status(503).json({
      ok: false,
      error: "AGV Super Admin email authorization is not configured",
    });
  }

  try {
    const claims = jwt.verify(token, AGV_SESSION_SECRET, {
      issuer: "agv-subscription-server",
      audience: "agv-platform",
    });

    const email = String(claims?.email || "")
      .trim()
      .toLowerCase();

    const role = String(claims?.role || "")
      .trim()
      .toLowerCase();

    const approvedRoles = new Set([
      "owner",
      "admin",
      "super_admin",
      "superadmin",
    ]);

    if (
      claims?.tokenType !== "agv_host_session" ||
      !email ||
      !approvedRoles.has(role) ||
      !AGV_SUPER_ADMIN_EMAILS.has(email)
    ) {
      return res.status(403).json({
        ok: false,
        error: "AGV Super Admin authorization is required",
      });
    }

    req.authUser = {
      username: email,
      displayName: email,
      globalRole: "superadmin",
      email,
      sessionSource: "agv-subscription-server",
    };

    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Invalid or expired AGV session",
    });
  }
}

function findRoom(roomId) {
  return rooms.find((room) => room.id === roomId);
}

function findUserByDisplayName(displayName) {
  const cleaned = cleanName(displayName);
  return users.find((user) => user.displayName === cleaned);
}

function getRole(room, authUser) {
  if (!authUser) return "viewer";
  if (authUser.globalRole === "superadmin") return "superadmin";
  if (!room) return "viewer";

  if (room.assignedHost === authUser.displayName) {
    return "host";
  }

  if (
    Array.isArray(room.moderators) &&
    room.moderators.includes(authUser.displayName)
  ) {
    return "moderator";
  }

  return "viewer";
}

function canManageModerators(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host";
}

function canManagePrivacy(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host" || role === "moderator";
}

function canControlStage(room, authUser) {
  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host";
}

function canEnterRoom(room, authUser) {
  if (!room.isLocked) return true;

  const role = getRole(room, authUser);
  return role === "superadmin" || role === "host" || role === "moderator";
}

function emitRooms() {
  io.emit("rooms:update", {
    rooms: rooms.map(normalizeRoom),
  });
}

function emitPresence(roomId) {
  io.to(`room:${roomId}`).emit("presence:update", {
    roomId,
    participants: getParticipantsForRoom(roomId),
  });
}

function emitRoomState(roomId) {
  io.to(`room:${roomId}`).emit("roomstate:update", {
    roomId,
    state: ensureRoomState(roomId),
  });
}

function emitBroadcast(roomId) {
  io.to(`room:${roomId}`).emit("broadcast:update", {
    roomId,
    broadcast: roomBroadcasts[roomId] || null,
  });
}

function emitRoomSnapshot(roomId) {
  const snapshot = getRoomSnapshot(roomId);
  if (!snapshot) return;

  io.to(`room:${roomId}`).emit("room:snapshot", snapshot);
}

function getParticipantsForRoom(roomId) {
  const roomPresence = presenceByRoom[roomId] || {};
  const now = Date.now();

  return Object.values(roomPresence)
    .filter((entry) => now - entry.lastSeenAt <= PRESENCE_STALE_MS)
    .map((entry) => ({
      sessionId: entry.sessionId,
      name: entry.name,
      role: entry.role,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function clearStalePresence() {
  const now = Date.now();

  for (const roomId of Object.keys(presenceByRoom)) {
    const roomPresence = presenceByRoom[roomId] || {};
    let changed = false;

    for (const sessionId of Object.keys(roomPresence)) {
      if (now - roomPresence[sessionId].lastSeenAt > PRESENCE_STALE_MS) {
        delete roomPresence[sessionId];
        changed = true;
      }
    }

    if (changed) {
      emitPresence(roomId);
      emitRoomSnapshot(roomId);
    }
  }
}

function joinPresence(roomId, authUser, sessionId) {
  if (!presenceByRoom[roomId]) {
    presenceByRoom[roomId] = {};
  }

  const room = findRoom(roomId);
  const role = getRole(room, authUser);

  presenceByRoom[roomId][sessionId] = {
    sessionId,
    username: authUser.username,
    name: authUser.displayName,
    role,
    lastSeenAt: Date.now(),
  };

  return getParticipantsForRoom(roomId);
}

function heartbeatPresence(roomId, authUser, sessionId) {
  if (!presenceByRoom[roomId]) {
    presenceByRoom[roomId] = {};
  }

  const room = findRoom(roomId);
  const role = getRole(room, authUser);
  const existing = presenceByRoom[roomId][sessionId];

  presenceByRoom[roomId][sessionId] = {
    ...(existing || {}),
    sessionId,
    username: authUser.username,
    name: authUser.displayName,
    role,
    lastSeenAt: Date.now(),
  };

  return getParticipantsForRoom(roomId);
}

function leavePresence(roomId, sessionId) {
  if (!presenceByRoom[roomId]) {
    return getParticipantsForRoom(roomId);
  }

  delete presenceByRoom[roomId][sessionId];
  return getParticipantsForRoom(roomId);
}

function disconnectPresence(sessionId) {
  for (const roomId of Object.keys(presenceByRoom)) {
    if (presenceByRoom[roomId][sessionId]) {
      delete presenceByRoom[roomId][sessionId];
      emitPresence(roomId);
      emitRoomSnapshot(roomId);
    }
  }
}

function endBroadcastForSocket(socketId) {
  for (const roomId of Object.keys(roomBroadcasts)) {
    if (roomBroadcasts[roomId]?.hostSocketId === socketId) {
      delete roomBroadcasts[roomId];

      emitBroadcast(roomId);
      emitRoomSnapshot(roomId);

      io.to(`room:${roomId}`).emit("webrtc:stage-ended", {
        roomId,
      });
    }
  }
}

loadData();
loadUsers();
setInterval(clearStalePresence, PRESENCE_SWEEP_MS);

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.length,
    users: users.length,
    timestamp: new Date().toISOString(),
  });
});



// PASS SENTINEL-BRIDGE-HEALTH-01
// Compatibility health contract consumed by AGV Sentinel.
app.get("/api/broadcast/bridge/health", (req, res) => {
  const cloudflareRtmpConfigured = Boolean(
    process.env.CLOUDFLARE_RTMP_URL ||
      process.env.CLOUDFLARE_RTMP_ENDPOINT ||
      process.env.CLOUDFLARE_STREAM_RTMP_URL
  );

  const cloudflareStreamKeyConfigured = Boolean(
    process.env.CLOUDFLARE_STREAM_KEY ||
      process.env.CLOUDFLARE_API_TOKEN
  );

  const cloudflarePlaybackConfigured = Boolean(
    process.env.CLOUDFLARE_PLAYBACK_URL ||
      process.env.CLOUDFLARE_STREAM_PLAYBACK_URL ||
      process.env.CLOUDFLARE_CUSTOMER_SUBDOMAIN
  );

  const config = {
    cloudflareRtmpConfigured,
    cloudflareStreamKeyConfigured,
    cloudflarePlaybackConfigured,
  };

  return res.json({
    ok: true,
    service: "AGV LiveKit to Cloudflare Egress Bridge",
    bridgeReady: true,
    viewerMode:
      process.env.AGV_VIEWER_MODE ||
      "LIVEKIT_SFU",
    config,
    cloudflareRtmpConfigured,
    cloudflareStreamKeyConfigured,
    cloudflarePlaybackConfigured,
    rooms: Array.isArray(rooms) ? rooms.length : 0,
    users: Array.isArray(users) ? users.length : 0,
    timestamp: new Date().toISOString(),
  });
});
// PASS33B_LIVEKIT_TOKEN_ROUTE_RESTORE
app.get("/api/livekit/health", (req, res) => {
  const livekitConfigured = Boolean(
    process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET
  );

  return res.json({
    ok: true,
    service: "AGV LiveKit Token Endpoint",
    livekitConfigured,
    livekitUrlConfigured: Boolean(process.env.LIVEKIT_URL),
    apiKeyConfigured: Boolean(process.env.LIVEKIT_API_KEY),
    apiSecretConfigured: Boolean(process.env.LIVEKIT_API_SECRET),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/livekit/token", requireAuth, async (req, res) => {
  try {
    const LIVEKIT_URL = process.env.LIVEKIT_URL;
    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "LiveKit env not configured",
        livekitUrlConfigured: Boolean(LIVEKIT_URL),
        apiKeyConfigured: Boolean(LIVEKIT_API_KEY),
        apiSecretConfigured: Boolean(LIVEKIT_API_SECRET),
      });
    }

    const { AccessToken } = require("livekit-server-sdk");

    const roomName =
      cleanName(req.body?.roomName) ||
      cleanName(req.body?.room) ||
      cleanName(req.body?.roomId) ||
      "main-hall";

    const requestedRole = cleanName(req.body?.role || req.body?.participantRole || "viewer").toLowerCase();

    const identityBase =
      cleanName(req.body?.identity) ||
      cleanName(req.body?.participantIdentity) ||
      cleanName(req.authUser?.username) ||
      cleanName(req.authUser?.displayName) ||
      "agv-user";

    const displayName =
      cleanName(req.body?.name) ||
      cleanName(req.body?.displayName) ||
      cleanName(req.authUser?.displayName) ||
      identityBase;

    const identity =
      identityBase
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") +
      "-" +
      Date.now();

    const canPublish =
      req.authUser?.globalRole === "superadmin" ||
      requestedRole === "host" ||
      requestedRole === "admin" ||
      requestedRole === "moderator" ||
      requestedRole === "superadmin" ||
      requestedRole === "super-admin" ||
      req.body?.canPublish === true;

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: displayName,
      metadata: JSON.stringify({
        agv: true,
        role: requestedRole,
        username: req.authUser?.username || "",
        displayName,
      }),
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canSubscribe: true,
      canPublish,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    return res.json({
      ok: true,
      token: jwt,
      participant_token: jwt,
      server_url: LIVEKIT_URL,
      url: LIVEKIT_URL,
      roomName,
      identity,
      name: displayName,
      canPublish,
    });
  } catch (error) {
    console.error("LIVEKIT TOKEN ERROR:", error);

    return res.status(500).json({
      ok: false,
      error: "LiveKit token failed",
      message: error?.message || "Unknown LiveKit token error",
    });
  }
});

app.post("/api/auth/login", (req, res) => {
  const username = cleanName(req.body?.username).toLowerCase();
  const password = String(req.body?.password || "");

  const user = users.find(
    (entry) => entry.username.toLowerCase() === username
  );

  if (!user || !user.isActive) {
    return res.status(401).json({ ok: false, error: "Login failed" });
  }

  const passwordOk = bcrypt.compareSync(password, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({ ok: false, error: "Login failed" });
  }

  const token = signToken(user);

  return res.json({
    ok: true,
    token,
    user: safeUser(user),
  });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    user: req.authUser,
  });
});

app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      ok: false,
      error: "Current and new passwords are required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "New password must be at least 8 characters",
    });
  }

  const user = users.find((entry) => entry.username === req.authUser.username);

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: "User not found",
    });
  }

  const passwordOk = bcrypt.compareSync(currentPassword, user.passwordHash);

  if (!passwordOk) {
    return res.status(401).json({
      ok: false,
      error: "Current password is incorrect",
    });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers();

  return res.json({ ok: true });
});

app.post("/api/auth/register", requireAuth, requireSuperadmin, (req, res) => {
  const username = cleanName(req.body?.username).toLowerCase();
  const displayName = cleanName(req.body?.displayName);
  const password = String(req.body?.password || "");
  const globalRole =
    cleanName(req.body?.globalRole) === "superadmin" ? "superadmin" : "user";

  if (!username || !displayName || !password) {
    return res.status(400).json({
      ok: false,
      error: "Username, display name, and password are required",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      error: "Password must be at least 8 characters",
    });
  }

  if (users.some((user) => user.username.toLowerCase() === username)) {
    return res.status(409).json({
      ok: false,
      error: "Username already exists",
    });
  }

  if (users.some((user) => user.displayName === displayName)) {
    return res.status(409).json({
      ok: false,
      error: "Display name already exists",
    });
  }

  const user = {
    username,
    displayName,
    passwordHash: bcrypt.hashSync(password, 10),
    globalRole,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  saveUsers();

  return res.json({
    ok: true,
    user: safeUser(user),
  });
});

// PASS CP-03 CONTENT PARTNER SUBMISSION DRAFT REGISTRY
app.post(
  "/api/content-partner/submissions/draft",
  (req, res) => {
    const validation =
      validateContentPartnerDraftPayload(req.body);

    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
      });
    }

    const submissions =
      loadContentPartnerSubmissions();

    const now = new Date().toISOString();
    const submissionId =
      createContentPartnerSubmissionId(submissions);

    const draftAccessToken =
      createContentPartnerDraftToken();

    const submission = {
      submissionId,
      status: "DRAFT_REGISTERED",
      createdAt: now,
      updatedAt: now,

      ...validation.normalized,

      review: {
        rightsCheck: "NOT_STARTED",
        technicalReview: "NOT_STARTED",
        editorialReview: "NOT_STARTED",
        approvalStatus: "NOT_STARTED",
        networkPlacement: "NOT_STARTED",
      },

      upload: {
        enabled: false,
        mediaIntakeId: null,
        uploadedAt: null,
      },

      publication: {
        eligible: false,
        publicAccess: false,
        publishedAt: null,
      },

      draftAccessTokenHash:
        hashContentPartnerDraftToken(
          draftAccessToken
        ),
    };

    submissions.push(submission);

    try {
      saveContentPartnerSubmissions(submissions);
    } catch (error) {
      console.error(
        "CONTENT PARTNER SUBMISSION SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not register the partner submission draft",
      });
    }

    return res.status(201).json({
      ok: true,
      submissionId,
      status: submission.status,
      draftAccessToken,
      submission:
        safeContentPartnerSubmission(submission),
      message:
        "Partner submission draft registered. Store the draft access token securely; it will not be returned again.",
    });
  }
);

app.get(
  "/api/content-partner/submissions/:submissionId",
  (req, res) => {
    const submissionId = cleanContentPartnerText(
      req.params?.submissionId,
      100
    );

    if (
      !/^AGV-CP-[A-Z0-9-]+$/i.test(submissionId)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "A valid partner submission ID is required",
      });
    }

    const draftAccessToken =
      readContentPartnerDraftToken(req);

    if (!draftAccessToken) {
      return res.status(401).json({
        ok: false,
        error:
          "The private partner draft access token is required",
      });
    }

    const submissions =
      loadContentPartnerSubmissions();

    const submission = submissions.find(
      (entry) =>
        entry.submissionId === submissionId
    );

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error:
          "Partner submission draft was not found",
      });
    }

    const suppliedHash =
      hashContentPartnerDraftToken(
        draftAccessToken
      );

    const storedHash = String(
      submission.draftAccessTokenHash || ""
    );

    const suppliedBuffer = Buffer.from(
      suppliedHash,
      "hex"
    );

    const storedBuffer = Buffer.from(
      storedHash,
      "hex"
    );

    const tokenMatches =
      suppliedBuffer.length === storedBuffer.length &&
      suppliedBuffer.length > 0 &&
      crypto.timingSafeEqual(
        suppliedBuffer,
        storedBuffer
      );

    if (!tokenMatches) {
      return res.status(403).json({
        ok: false,
        error:
          "The partner draft access token is invalid",
      });
    }

    return res.json({
      ok: true,
      submissionId: submission.submissionId,
      status: submission.status,
      submission:
        safeContentPartnerSubmission(submission),
    });
  }
);

// PASS CP-06 SECURE PARTNER MEDIA INTAKE RESERVATION
app.post(
  "/api/content-partner/submissions/:submissionId/reserve-media-intake",
  (req, res) => {
    const submissionId = cleanContentPartnerText(
      req.params?.submissionId,
      100
    );

    if (!/^AGV-CP-[A-Z0-9-]+$/i.test(submissionId)) {
      return res.status(400).json({
        ok: false,
        error: "A valid partner submission ID is required",
      });
    }

    const draftAccessToken =
      readContentPartnerDraftToken(req);

    if (!draftAccessToken) {
      return res.status(401).json({
        ok: false,
        error:
          "The private partner draft access token is required",
      });
    }

    const submissions =
      loadContentPartnerSubmissions();

    const submissionIndex = submissions.findIndex(
      (entry) => entry.submissionId === submissionId
    );

    if (submissionIndex < 0) {
      return res.status(404).json({
        ok: false,
        error: "Partner submission draft was not found",
      });
    }

    const submission = submissions[submissionIndex];

    const suppliedHash =
      hashContentPartnerDraftToken(draftAccessToken);

    const storedHash = String(
      submission.draftAccessTokenHash || ""
    );

    const suppliedBuffer = Buffer.from(
      suppliedHash,
      "hex"
    );

    const storedBuffer = Buffer.from(
      storedHash,
      "hex"
    );

    const tokenMatches =
      suppliedBuffer.length === storedBuffer.length &&
      suppliedBuffer.length > 0 &&
      crypto.timingSafeEqual(
        suppliedBuffer,
        storedBuffer
      );

    if (!tokenMatches) {
      return res.status(403).json({
        ok: false,
        error: "The partner draft access token is invalid",
      });
    }

    const mediaIntakes = loadMediaIntakes();

    const existingIntakeId = cleanContentPartnerText(
      submission?.upload?.mediaIntakeId,
      100
    );

    if (existingIntakeId) {
      const existingIntake = mediaIntakes.find(
        (entry) => entry.intakeId === existingIntakeId
      );

      if (!existingIntake) {
        return res.status(409).json({
          ok: false,
          error:
            "The Partner submission references a missing media intake. Founder review is required before another reservation can be created.",
        });
      }

      return res.json({
        ok: true,
        duplicatePrevented: true,
        submissionId,
        partnerStatus: submission.status,
        intakeId: existingIntake.intakeId,
        intakeStatus: existingIntake.status,
        uploadEnabled: false,
        mediaUploaded: Boolean(
          existingIntake?.upload?.storedFilename
        ),
        submission:
          safeContentPartnerSubmission(submission),
        message:
          "The existing controlled media intake reservation was returned.",
      });
    }

    if (submission.status !== "DRAFT_REGISTERED") {
      return res.status(409).json({
        ok: false,
        error:
          "Only a registered Partner draft without an existing intake may reserve media intake.",
      });
    }

    const expectedFilename =
      cleanContentPartnerText(
        submission?.fileMetadata?.featureName,
        255
      );

    const requestedFilename =
      cleanContentPartnerText(
        req.body?.filename || req.body?.fileName,
        255
      );

    if (!expectedFilename || !requestedFilename) {
      return res.status(400).json({
        ok: false,
        error:
          "The exact registered feature-film filename is required",
      });
    }

    if (requestedFilename !== expectedFilename) {
      return res.status(409).json({
        ok: false,
        error:
          "The requested filename does not match the registered feature-film filename",
      });
    }

    const filesize = Number(
      req.body?.filesize ?? req.body?.fileSize
    );

    if (
      !Number.isFinite(filesize) ||
      filesize <= 0 ||
      !Number.isSafeInteger(filesize)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "A positive, whole-number feature-film filesize is required",
      });
    }

    if (filesize > CONTROLLED_MEDIA_MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        error:
          "The feature film exceeds the configured AGV controlled-media size limit",
      });
    }

    const mimetype =
      cleanContentPartnerText(
        req.body?.mimetype || req.body?.mimeType,
        150
      ) || "application/octet-stream";

    const extension = path
      .extname(expectedFilename)
      .toLowerCase();

    if (!CONTROLLED_MEDIA_EXTENSIONS.has(extension)) {
      return res.status(400).json({
        ok: false,
        error:
          "The registered feature-film extension is not supported",
      });
    }

    const rights = submission.rightsDeclarations || {};

    const rightsConfirmed =
      rights.ownsFilmRights === true &&
      rights.musicClearance === true &&
      rights.footageClearance === true &&
      rights.talentReleases === true &&
      rights.distributionAuthority === true;

    if (!rightsConfirmed) {
      return res.status(409).json({
        ok: false,
        error:
          "All Partner rights declarations must remain confirmed before intake reservation",
      });
    }

    const now = new Date().toISOString();

    const intake = {
      intakeId: createMediaIntakeId(mediaIntakes),
      status: "AWAITING_SECURE_UPLOAD",
      createdAt: now,
      updatedAt: now,

      source: "AGV_CONTENT_PARTNER_PORTAL",
      partnerSubmissionId: submissionId,

      createdBy: {
        username: cleanMediaIntakeText(
          submission?.partner?.contactEmail,
          150
        ),
        displayName: cleanMediaIntakeText(
          submission?.partner?.contactName,
          200
        ),
        globalRole: "content_partner",
      },

      title: cleanMediaIntakeText(
        submission?.film?.title,
        200
      ),

      description: cleanMediaIntakeText(
        submission?.film?.synopsis,
        4000
      ),

      filename: expectedFilename,
      filesize,
      mimetype,

      category:
        cleanMediaIntakeText(
          submission?.film?.genre,
          150
        ) || "Independent Film",

      visibility: "OWNER_PRIVATE_REVIEW",

      attribution:
        cleanMediaIntakeText(
          submission?.partner?.organizationName ||
            submission?.partner?.channelName ||
            submission?.partner?.contactName,
          1000
        ),

      rightsConfirmed: true,

      partnerControls: {
        reservationAuthorized: true,
        partnerUploadEnabled: false,
        founderReviewRequired: true,
      },

      publicAccess: false,
    };

    const originalSubmission = submissions[submissionIndex];

    const updatedSubmission = {
      ...originalSubmission,
      status: "AWAITING_SECURE_UPLOAD",
      updatedAt: now,

      upload: {
        ...(originalSubmission.upload || {}),
        reservationCreated: true,
        reservedAt: now,
        enabled: false,
        partnerUploadEnabled: false,
        mediaIntakeId: intake.intakeId,
        uploadedAt: null,
      },

      publication: {
        ...(originalSubmission.publication || {}),
        eligible: false,
        publicAccess: false,
        publishedAt: null,
      },
    };

    mediaIntakes.push(intake);
    submissions[submissionIndex] = updatedSubmission;

    try {
      saveMediaIntakes(mediaIntakes);
      saveContentPartnerSubmissions(submissions);
    } catch (error) {
      console.error(
        "PARTNER MEDIA INTAKE RESERVATION SAVE FAILED:",
        error.message
      );

      try {
        const rollbackIntakes = loadMediaIntakes().filter(
          (entry) => entry.intakeId !== intake.intakeId
        );

        saveMediaIntakes(rollbackIntakes);
      } catch (rollbackError) {
        console.error(
          "PARTNER MEDIA INTAKE ROLLBACK FAILED:",
          rollbackError.message
        );
      }

      return res.status(500).json({
        ok: false,
        error:
          "Could not create the secure Partner media intake reservation",
      });
    }

    return res.status(201).json({
      ok: true,
      duplicatePrevented: false,
      submissionId,
      partnerStatus: updatedSubmission.status,
      intakeId: intake.intakeId,
      intakeStatus: intake.status,
      uploadEnabled: false,
      mediaUploaded: false,
      publicAccess: false,
      submission:
        safeContentPartnerSubmission(updatedSubmission),
      intake: {
        intakeId: intake.intakeId,
        status: intake.status,
        title: intake.title,
        filename: intake.filename,
        filesize: intake.filesize,
        mimetype: intake.mimetype,
        category: intake.category,
        visibility: intake.visibility,
        partnerSubmissionId:
          intake.partnerSubmissionId,
        partnerUploadEnabled: false,
        publicAccess: false,
      },
      message:
        "Secure Partner media intake reserved. No media file was uploaded.",
    });
  }
);

// PASS CU-07E — CONTROLLED MEDIA INTAKE RESERVATION
app.post(
  "/api/media/intake/prepare",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const title = cleanMediaIntakeText(req.body?.title, 200);
    const description = cleanMediaIntakeText(req.body?.description, 4000);
    const filename = cleanMediaIntakeText(
      req.body?.filename || req.body?.fileName,
      255
    );
    const mimetype = cleanMediaIntakeText(
      req.body?.mimetype || req.body?.mimeType,
      150
    );
    const category =
      cleanMediaIntakeText(req.body?.category, 150) || "Uncategorized";
    const visibility =
      cleanMediaIntakeText(req.body?.visibility, 100) || "DRAFT";
    const attribution = cleanMediaIntakeText(
      req.body?.attribution,
      1000
    );
    const rightsConfirmed = req.body?.rightsConfirmed === true;
    const filesize = Number(
      req.body?.filesize ?? req.body?.fileSize
    );

    if (!title || !description || !filename) {
      return res.status(400).json({
        ok: false,
        error: "Title, description, and filename are required",
      });
    }

    if (
      !Number.isFinite(filesize) ||
      filesize < 0 ||
      !Number.isSafeInteger(filesize)
    ) {
      return res.status(400).json({
        ok: false,
        error: "A valid filesize is required",
      });
    }

    if (!rightsConfirmed) {
      return res.status(400).json({
        ok: false,
        error: "Rights confirmation is required",
      });
    }

    const mediaIntakes = loadMediaIntakes();
    const now = new Date().toISOString();

    const intake = {
      intakeId: createMediaIntakeId(mediaIntakes),
      status: "AWAITING_SECURE_UPLOAD",
      createdAt: now,
      updatedAt: now,
      createdBy: {
        username: cleanMediaIntakeText(
          req.authUser?.username,
          150
        ),
        displayName: cleanMediaIntakeText(
          req.authUser?.displayName,
          200
        ),
        globalRole: cleanMediaIntakeText(
          req.authUser?.globalRole,
          50
        ),
      },
      title,
      description,
      filename,
      filesize,
      mimetype,
      category,
      visibility,
      attribution,
      rightsConfirmed: true,
    };

    mediaIntakes.push(intake);

    try {
      saveMediaIntakes(mediaIntakes);
    } catch (error) {
      console.error("MEDIA INTAKE SAVE FAILED:", error.message);

      return res.status(500).json({
        ok: false,
        error: "Could not reserve the controlled upload intake",
      });
    }

    return res.status(201).json({
      ok: true,
      intakeId: intake.intakeId,
      status: intake.status,
      intake,
    });
  }
);

// PASS YTI-01 - REQUESTED FOUNDER YOUTUBE INTAKE SEED
function ensureRequestedFounderYouTubeIntake() {
  const videoId = "ZKhUAV0Extw";
  const sourceUrl = "https://youtu.be/ZKhUAV0Extw";
  const mediaIntakes = loadMediaIntakes();

  const existingIntake = mediaIntakes.find(
    (entry) =>
      String(
        entry?.videoId ||
          entry?.externalMedia?.videoId ||
          ""
      ).trim() === videoId ||
      String(entry?.sourceUrl || "").trim() ===
        sourceUrl
  );

  if (existingIntake) {
    return existingIntake;
  }

  const now = new Date().toISOString();
  const founderActor = {
    username: "agv-founder",
    displayName: "AGV Founder",
    globalRole: "superadmin",
  };

  const intake = {
    intakeId: createMediaIntakeId(mediaIntakes),
    status: "PUBLISHED_PRIVATE_TEST",
    createdAt: now,
    updatedAt: now,
    uploadedAt: now,
    publishedAt: now,

    source: "AGV_FOUNDER_CONTROLLED_INTAKE",
    sourceType: "YOUTUBE",
    mediaOrigin: "EXTERNAL_YOUTUBE",
    sourceUrl,
    videoId,
    embedUrl:
      "https://www.youtube-nocookie.com/embed/" +
      videoId +
      "?autoplay=1&playsinline=1&controls=1&fs=1&rel=0",
    thumbnail:
      "https://i.ytimg.com/vi/" +
      videoId +
      "/hqdefault.jpg",

    title: "Magnificent Pool Party 8/1/26",
    description:
      "Founder-submitted AGV Owned Original YouTube presentation.",
    filename: "youtube-" + videoId,
    filesize: 0,
    mimetype: "text/html",
    category: "AGV Original",
    visibility: "Private",
    attribution: "Avant Global Vision",
    rightsConfirmed: true,
    publicAccess: false,

    createdBy: founderActor,

    review: {
      decision: "APPROVED",
      reviewedAt: now,
      reviewedBy: founderActor,
      approvalSource: "FOUNDER_EXTERNAL_INTAKE",
    },

    rightsClearance: {
      status: "CLEARED_FOR_PUBLIC_PUBLISHING",
      rightsBasis: "OWNED_ORIGINAL",
      attribution: "Avant Global Vision",
      sourceUrl,
      certifiedAt: now,
      certifiedBy: founderActor,
      certificationSource: "FOUNDER_EXTERNAL_INTAKE",
      founderSelfCertified: true,
    },

    founderSubmission: {
      ownedOriginal: true,
      selfCertifiedAt: now,
      selfCertifiedBy: founderActor,
    },

    externalMedia: {
      provider: "YouTube",
      sourceType: "YOUTUBE",
      videoId,
      sourceUrl,
      embedUrl:
        "https://www.youtube-nocookie.com/embed/" +
        videoId +
        "?autoplay=1&playsinline=1&controls=1&fs=1&rel=0",
      thumbnail:
        "https://i.ytimg.com/vi/" +
        videoId +
        "/hqdefault.jpg",
    },

    publication: {
      mode: "OWNER_PRIVATE_TEST",
      destination: "AGV_NETWORK_ON_DEMAND_PRIVATE",
      publishedAt: now,
      publishedBy: founderActor,
      priorStatus: "FOUNDER_EXTERNAL_INTAKE",
      publicAccess: false,
      permanentPublicUrl: null,
    },
  };

  mediaIntakes.push(intake);
  saveMediaIntakes(mediaIntakes);

  console.log(
    "YTI-01 FOUNDER YOUTUBE INTAKE CREATED:",
    intake.intakeId,
    videoId
  );

  return intake;
}

// PASS MRM-01 - REQUESTED YOUTUBE SEED RETIRED
// The original requested item already entered the intake registry.
// Disabling the startup seed allows Super Admin removal to remain permanent.
const REQUESTED_FOUNDER_YOUTUBE_SEED_ENABLED = false;

if (REQUESTED_FOUNDER_YOUTUBE_SEED_ENABLED) {
  try {
    ensureRequestedFounderYouTubeIntake();
  } catch (error) {
    console.error(
      "YTI-01 FOUNDER YOUTUBE INTAKE FAILED:",
      error.message
    );
  }
}

// PASS CU-09A2 SECURE CONTROLLED MEDIA UPLOAD
app.post(
  "/api/media/intake/:intakeId/upload",
  requireControlledMediaSuperadmin,
  requireReservedControlledMediaIntake,
  (req, res) => {
    controlledMediaUpload.single("media")(
      req,
      res,
      (uploadError) => {
        if (uploadError) {
          removeControlledUploadFile(req.file?.path);

          const isSizeError =
            uploadError?.code === "LIMIT_FILE_SIZE";

          return res.status(
            isSizeError ? 413 : 400
          ).json({
            ok: false,
            error: isSizeError
              ? "The selected media file exceeds the upload limit"
              : uploadError?.message ||
                "The controlled media upload failed",
          });
        }

        if (!req.file) {
          return res.status(400).json({
            ok: false,
            error: "A media file is required",
          });
        }

        const mediaIntakes = loadMediaIntakes();
        const intakeIndex = mediaIntakes.findIndex(
          (entry) =>
            entry.intakeId ===
            req.controlledMediaIntakeId
        );

        if (intakeIndex < 0) {
          removeControlledUploadFile(req.file.path);

          return res.status(404).json({
            ok: false,
            error: "Controlled media intake was not found",
          });
        }

        const intake = mediaIntakes[intakeIndex];

        if (intake.status !== "AWAITING_SECURE_UPLOAD") {
          removeControlledUploadFile(req.file.path);

          return res.status(409).json({
            ok: false,
            error:
              "This intake is no longer awaiting an upload",
            status: intake.status,
          });
        }

        const expectedName = path.basename(
          String(intake.filename || "")
        );

        const receivedName = path.basename(
          String(req.file.originalname || "")
        );

        const expectedSize = Number(intake.filesize);
        const receivedSize = Number(req.file.size);

        if (
          expectedName !== receivedName ||
          !Number.isSafeInteger(receivedSize) ||
          receivedSize < 1 ||
          expectedSize !== receivedSize
        ) {
          removeControlledUploadFile(req.file.path);

          return res.status(409).json({
            ok: false,
            error:
              "The uploaded file does not match the reserved intake metadata",
          });
        }

        const now = new Date().toISOString();

        const updatedIntake = {
          ...intake,
          status: "UPLOADED_PENDING_REVIEW",
          updatedAt: now,
          uploadedAt: now,
          upload: {
            originalFilename: receivedName,
            storedFilename: path.basename(
              req.file.filename
            ),
            storageArea:
              "CONTROLLED_MEDIA_UPLOAD_DIR",
            relativePath: path.relative(
              __dirname,
              req.file.path
            ),
            filesize: receivedSize,
            mimetype: cleanMediaIntakeText(
              req.file.mimetype,
              150
            ),
            uploadedBy: {
              username: cleanMediaIntakeText(
                req.authUser?.username,
                150
              ),
              displayName: cleanMediaIntakeText(
                req.authUser?.displayName,
                200
              ),
              globalRole: cleanMediaIntakeText(
                req.authUser?.globalRole,
                50
              ),
            },
          },
        };

        mediaIntakes[intakeIndex] = updatedIntake;

        try {
          saveMediaIntakes(mediaIntakes);
        } catch (error) {
          removeControlledUploadFile(req.file.path);

          return res.status(500).json({
            ok: false,
            error:
              "The media file was received but the intake record could not be updated",
          });
        }

        return res.status(201).json({
          ok: true,
          intakeId: updatedIntake.intakeId,
          status: updatedIntake.status,
          intake: updatedIntake,
          message:
            "Media uploaded securely and is pending review",
        });
      }
    );
  }
);

// PASS CU-10B FOUNDER MEDIA REVIEW FOUNDATION
// Protected metadata review only. No playback, publishing, or deletion.
function getControlledMediaReviewActor(req) {
  return {
    username: cleanMediaIntakeText(
      req.authUser?.username,
      150
    ),
    displayName: cleanMediaIntakeText(
      req.authUser?.displayName,
      200
    ),
    globalRole: cleanMediaIntakeText(
      req.authUser?.globalRole,
      50
    ),
    email: cleanMediaIntakeText(
      req.authUser?.email,
      200
    ),
  };
}

// PASS CP-08A FOUNDER LINKED PARTNER REVIEW DATA
function findLinkedContentPartnerSubmission(intake) {
  const partnerSubmissionId =
    cleanContentPartnerText(
      intake?.partnerSubmissionId,
      100
    );

  if (
    !partnerSubmissionId ||
    !/^AGV-CP-[A-Z0-9-]+$/i.test(
      partnerSubmissionId
    )
  ) {
    return null;
  }

  const submissions =
    loadContentPartnerSubmissions();

  const submission = submissions.find(
    (entry) =>
      entry.submissionId === partnerSubmissionId
  );

  return safeContentPartnerSubmission(submission);
}

function getFounderPartnerReviewSummary(intake) {
  const submission =
    findLinkedContentPartnerSubmission(intake);

  if (!submission) {
    return null;
  }

  return {
    submissionId: submission.submissionId,
    status: submission.status,

    channelName:
      submission?.partner?.channelName || "",

    partnerName:
      submission?.partner?.contactName || "",

    partnerEmail:
      submission?.partner?.contactEmail || "",

    organizationName:
      submission?.partner?.organizationName || "",

    filmTitle:
      submission?.film?.title || intake?.title || "",

    genre:
      submission?.film?.genre || intake?.category || "",

    releaseType:
      submission?.releaseSetup?.releaseType || "",

    technicalReview:
      submission?.review?.technicalReview ||
      "NOT_STARTED",

    approvalStatus:
      submission?.review?.approvalStatus ||
      "NOT_STARTED",

    networkPlacement:
      submission?.review?.networkPlacement ||
      "NOT_STARTED",

    mediaIntakeId:
      submission?.upload?.mediaIntakeId ||
      intake?.intakeId ||
      "",
  };
}

function findControlledMediaIntakeById(intakeId) {
  const safeIntakeId = cleanMediaIntakeText(
    intakeId,
    100
  );

  if (!/^AGV-CU-[A-Z0-9-]+$/i.test(safeIntakeId)) {
    return {
      ok: false,
      error: "A valid controlled intake ID is required",
      statusCode: 400,
    };
  }

  const mediaIntakes = loadMediaIntakes();
  const intakeIndex = mediaIntakes.findIndex(
    (entry) => entry.intakeId === safeIntakeId
  );

  if (intakeIndex < 0) {
    return {
      ok: false,
      error: "Controlled media intake was not found",
      statusCode: 404,
    };
  }

  return {
    ok: true,
    mediaIntakes,
    intakeIndex,
    intake: mediaIntakes[intakeIndex],
  };
}

app.get(
  "/api/media/review",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const mediaIntakes = loadMediaIntakes();

    const reviewItems = mediaIntakes
      .filter((entry) =>
        [
          "UPLOADED_PENDING_REVIEW",
          "APPROVED_FOR_PRIVATE_PUBLISHING",
          "REJECTED_BY_FOUNDER",
          "PUBLISHED_PRIVATE_TEST",
          "PUBLICATION_READY_STAGED",
          "PUBLISHED_PUBLIC",
          "UNPUBLISHED",
        ].includes(entry.status)
      )
      .sort((left, right) =>
        String(
          right.updatedAt ||
            right.createdAt ||
            ""
        ).localeCompare(
          String(
            left.updatedAt ||
              left.createdAt ||
              ""
          )
        )
      )
      .map((entry) => ({
        ...entry,
        linkedPartner:
          getFounderPartnerReviewSummary(entry),
      }));

    return res.json({
      ok: true,
      count: reviewItems.length,
      partnerLinkedCount:
        reviewItems.filter(
          (entry) => Boolean(entry.linkedPartner)
        ).length,
      items: reviewItems,
    });
  }
);

app.get(
  "/api/media/review/:intakeId",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const linkedPartnerSubmission =
      findLinkedContentPartnerSubmission(
        lookup.intake
      );

    const storedFilename = path.basename(
      String(
        lookup.intake?.upload?.storedFilename ||
          ""
      )
    );

    const storedPath = storedFilename
      ? path.join(
          CONTROLLED_MEDIA_UPLOAD_DIR,
          storedFilename
        )
      : "";

    return res.json({
      ok: true,
      intake: lookup.intake,

      linkedPartnerSubmission,

      linkedPartnerAvailable:
        Boolean(linkedPartnerSubmission),

      partnerSubmissionId:
        linkedPartnerSubmission?.submissionId ||
        lookup.intake?.partnerSubmissionId ||
        null,

      privatePreviewAvailable:
        Boolean(storedFilename) &&
        Boolean(storedPath) &&
        fs.existsSync(storedPath),

      reviewWorkspace: {
        source:
          linkedPartnerSubmission
            ? "AGV_CONTENT_PARTNER_PORTAL"
            : "CONTROLLED_MEDIA_INTAKE",

        ownerPrivate:
          lookup.intake?.publicAccess !== true,

        publicAccess:
          lookup.intake?.publicAccess === true,

        founderDecision:
          lookup.intake?.review?.decision ||
          "NOT_DECIDED",

        rightsStatus:
          lookup.intake?.rightsClearance?.status ||
          linkedPartnerSubmission?.review
            ?.rightsCheck ||
          "NOT_STARTED",

        technicalReview:
          linkedPartnerSubmission?.review
            ?.technicalReview ||
          "NOT_STARTED",

        editorialReview:
          linkedPartnerSubmission?.review
            ?.editorialReview ||
          "NOT_STARTED",

        approvalStatus:
          linkedPartnerSubmission?.review
            ?.approvalStatus ||
          "NOT_STARTED",

        networkPlacement:
          linkedPartnerSubmission?.review
            ?.networkPlacement ||
          "NOT_STARTED",

        automaticApproval: false,
        automaticPublication: false,
      },
    });
  }
);

// PASS CP-08C SYNCHRONIZE FOUNDER DECISIONS TO PARTNER SUBMISSION
function saveFounderDecisionWithPartnerSync({
  intakeLookup,
  updatedIntake,
  decision,
  decisionNote,
  rejectionReason,
  reviewedAt,
  reviewedBy,
}) {
  const originalIntake = intakeLookup.intake;

  intakeLookup.mediaIntakes[intakeLookup.intakeIndex] =
    updatedIntake;

  const partnerSubmissionId =
    cleanContentPartnerText(
      originalIntake?.partnerSubmissionId,
      100
    );

  if (!partnerSubmissionId) {
    saveMediaIntakes(intakeLookup.mediaIntakes);

    return {
      partnerSynchronized: false,
      partnerSubmission: null,
    };
  }

  if (
    !/^AGV-CP-[A-Z0-9-]+$/i.test(
      partnerSubmissionId
    )
  ) {
    throw new Error(
      "The linked Partner submission ID is invalid"
    );
  }

  const submissions =
    loadContentPartnerSubmissions();

  const submissionIndex = submissions.findIndex(
    (entry) =>
      entry.submissionId === partnerSubmissionId
  );

  if (submissionIndex < 0) {
    throw new Error(
      "The linked Partner submission was not found"
    );
  }

  const originalSubmission =
    submissions[submissionIndex];

  if (
    originalSubmission?.upload?.mediaIntakeId !==
      originalIntake.intakeId
  ) {
    throw new Error(
      "The Partner submission and controlled intake linkage could not be verified"
    );
  }

  const isApproved = decision === "APPROVED";

  const updatedSubmission = {
    ...originalSubmission,

    status: isApproved
      ? "FOUNDER_APPROVED_PRIVATE_PUBLISHING"
      : "REJECTED_BY_FOUNDER",

    updatedAt: reviewedAt,

    review: {
      ...(originalSubmission.review || {}),

      rightsCheck:
        originalSubmission?.review?.rightsCheck ||
        "NOT_STARTED",

      technicalReview: isApproved
        ? "PASSED"
        : (
            originalSubmission?.review
              ?.technicalReview ||
            "READY_FOR_REVIEW"
          ),

      editorialReview: isApproved
        ? "APPROVED"
        : "REJECTED",

      approvalStatus: isApproved
        ? "FOUNDER_APPROVED"
        : "REJECTED",

      networkPlacement: isApproved
        ? "AWAITING_PRIVATE_PUBLISHING"
        : "NOT_ELIGIBLE",

      founderDecision: {
        decision,
        note: isApproved
          ? cleanContentPartnerText(
              decisionNote,
              1000
            )
          : "",

        rejectionReason: isApproved
          ? ""
          : cleanContentPartnerText(
              rejectionReason,
              1000
            ),

        reviewedAt,
        reviewedBy,
      },
    },

    publication: {
      ...(originalSubmission.publication || {}),
      eligible: false,
      publicAccess: false,
      publishedAt:
        originalSubmission?.publication?.publishedAt ||
        null,
    },
  };

  submissions[submissionIndex] =
    updatedSubmission;

  saveMediaIntakes(intakeLookup.mediaIntakes);

  try {
    saveContentPartnerSubmissions(submissions);
  } catch (partnerSaveError) {
    try {
      const rollbackIntakes = loadMediaIntakes();

      const rollbackIndex =
        rollbackIntakes.findIndex(
          (entry) =>
            entry.intakeId === originalIntake.intakeId
        );

      if (rollbackIndex >= 0) {
        rollbackIntakes[rollbackIndex] =
          originalIntake;

        saveMediaIntakes(rollbackIntakes);
      }
    } catch (rollbackError) {
      console.error(
        "CP-08C MEDIA DECISION ROLLBACK FAILED:",
        rollbackError.message
      );
    }

    throw partnerSaveError;
  }

  return {
    partnerSynchronized: true,
    partnerSubmission:
      safeContentPartnerSubmission(
        updatedSubmission
      ),
  };
}

// PASS PTK-01 - PARTNER MEDIA EMERGENCY TAKEDOWN
// Public access stops immediately while the media file and audit
// evidence remain preserved for Founder and compliance review.
app.post(
  "/api/media/review/:intakeId/partner-takedown",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const partnerSubmissionId =
      cleanContentPartnerText(
        lookup.intake?.partnerSubmissionId,
        100
      );

    const partnerOrigin =
      lookup.intake?.source ===
        "AGV_CONTENT_PARTNER_PORTAL" &&
      /^AGV-CP-[A-Z0-9-]+$/i.test(
        partnerSubmissionId
      );

    if (!partnerOrigin) {
      return res.status(409).json({
        ok: false,
        error:
          "This protected takedown route is only for linked Partner Portal media",
      });
    }

    const confirmation = cleanMediaIntakeText(
      req.body?.confirmation,
      200
    );

    if (
      confirmation !==
      "TAKE DOWN PARTNER MEDIA"
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Super Admin confirmation phrase TAKE DOWN PARTNER MEDIA is required",
      });
    }

    const reason = cleanMediaIntakeText(
      req.body?.reason,
      1500
    );

    if (reason.length < 10) {
      return res.status(400).json({
        ok: false,
        error:
          "A meaningful partner-takedown reason of at least 10 characters is required",
      });
    }

    const violationCategory =
      cleanMediaIntakeText(
        req.body?.violationCategory,
        200
      ) || "PLATFORM_POLICY_VIOLATION";

    const submissions =
      loadContentPartnerSubmissions();

    const submissionIndex =
      submissions.findIndex(
        (entry) =>
          entry.submissionId ===
          partnerSubmissionId
      );

    if (submissionIndex < 0) {
      return res.status(409).json({
        ok: false,
        error:
          "The linked Partner submission could not be found",
      });
    }

    const originalSubmission =
      submissions[submissionIndex];

    if (
      originalSubmission?.upload?.mediaIntakeId &&
      originalSubmission.upload.mediaIntakeId !==
        lookup.intake.intakeId
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "The Partner submission and media intake linkage could not be verified",
      });
    }

    const originalIntake = lookup.intake;
    const now = new Date().toISOString();
    const actor =
      getControlledMediaReviewActor(req);

    const takedownRecord = {
      status: "ACTIVE_TAKEDOWN_HOLD",
      action:
        "PARTNER_MEDIA_EMERGENCY_TAKEDOWN",
      reason,
      violationCategory,
      occurredAt: now,
      actor,
      evidencePreserved: true,
      publicPlaybackStopped: true,
    };

    const priorModerationAudit =
      Array.isArray(
        originalIntake?.moderationAudit
      )
        ? originalIntake.moderationAudit
        : [];

    const updatedIntake = {
      ...originalIntake,

      status: "PUBLISHED_PRIVATE_TEST",
      visibility: "Private",
      publicAccess: false,
      updatedAt: now,
      publicUnpublishedAt: now,

      moderationStatus:
        "PARTNER_TAKEDOWN_HOLD",

      moderation: {
        ...(originalIntake.moderation || {}),
        ...takedownRecord,
      },

      moderationAudit: [
        ...priorModerationAudit,
        takedownRecord,
      ].slice(-100),

      partnerControls: {
        ...(originalIntake.partnerControls || {}),
        suspendedByAgv: true,
        partnerUploadEnabled: false,
        publicPublishingBlocked: true,
        takedownAt: now,
        takedownBy: actor,
        takedownReason: reason,
        violationCategory,
      },

      publication: {
        ...(originalIntake.publication || {}),
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        takedownAt: now,
        takedownBy: actor,
        takedownReason: reason,
      },

      publicPublication: {
        ...(originalIntake.publicPublication || {}),
        registryStatus:
          "PARTNER_TAKEDOWN_HOLD",
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        emergencyBlocked: true,
        emergencyBlockedAt: now,
        emergencyBlockedBy: actor,
        emergencyBlockReason: reason,
        scheduled: false,
        publishAt: null,
        playbackPath: null,
        permanentPublicUrl: null,
        unpublishedAt: now,
        unpublishedBy: actor,
      },

      publicationAudit:
        appendControlledMediaPublicationAudit(
          originalIntake,
          "PARTNER_MEDIA_EMERGENCY_TAKEDOWN",
          actor,
          {
            reason,
            violationCategory,
            partnerSubmissionId,
            publicAccess: false,
            playbackEnabled: false,
            evidencePreserved: true,
          }
        ),
    };

    const updatedSubmission = {
      ...originalSubmission,

      status: "SUSPENDED_BY_AGV",
      updatedAt: now,

      review: {
        ...(originalSubmission.review || {}),
        approvalStatus:
          "SUSPENDED_BY_AGV",
        networkPlacement:
          "REMOVED_BY_AGV",
      },

      publication: {
        ...(originalSubmission.publication || {}),
        eligible: false,
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        suspendedAt: now,
        suspendedBy: actor,
        suspensionReason: reason,
      },

      moderation: {
        ...(originalSubmission.moderation || {}),
        ...takedownRecord,
        mediaIntakeId:
          originalIntake.intakeId,
      },
    };

    lookup.mediaIntakes[
      lookup.intakeIndex
    ] = updatedIntake;

    submissions[submissionIndex] =
      updatedSubmission;

    try {
      saveMediaIntakes(
        lookup.mediaIntakes
      );
    } catch (error) {
      console.error(
        "PARTNER TAKEDOWN MEDIA SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the Partner media takedown",
      });
    }

    try {
      saveContentPartnerSubmissions(
        submissions
      );
    } catch (error) {
      try {
        const rollbackIntakes =
          loadMediaIntakes();

        const rollbackIndex =
          rollbackIntakes.findIndex(
            (entry) =>
              entry.intakeId ===
              originalIntake.intakeId
          );

        if (rollbackIndex >= 0) {
          rollbackIntakes[rollbackIndex] =
            originalIntake;

          saveMediaIntakes(
            rollbackIntakes
          );
        }
      } catch (rollbackError) {
        console.error(
          "PARTNER TAKEDOWN ROLLBACK FAILED:",
          rollbackError.message
        );
      }

      console.error(
        "PARTNER TAKEDOWN SUBMISSION SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "The media takedown was rolled back because the Partner submission could not be updated",
      });
    }

    for (
      const [ticket, ticketRecord]
      of controlledMediaPreviewTickets.entries()
    ) {
      if (
        ticketRecord?.intakeId ===
        originalIntake.intakeId
      ) {
        controlledMediaPreviewTickets.delete(
          ticket
        );
      }
    }

    console.log(
      "PARTNER MEDIA TAKEN DOWN:",
      originalIntake.intakeId,
      partnerSubmissionId,
      violationCategory,
      reason
    );

    return res.json({
      ok: true,
      takenDown: true,
      intakeId:
        updatedIntake.intakeId,
      partnerSubmissionId,
      status:
        updatedIntake.status,
      moderationStatus:
        updatedIntake.moderationStatus,
      publicAccess: false,
      playbackEnabled: false,
      evidencePreserved: true,
      intake: updatedIntake,
      partnerSubmission:
        safeContentPartnerSubmission(
          updatedSubmission
        ),
      message:
        "Partner media was taken down immediately. Public playback is disabled and the evidence remains preserved.",
    });
  }
);

// PASS MRM-01 - SUPER ADMIN MEDIA REMOVAL
app.delete(
  "/api/media/review/:intakeId",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const confirmation = cleanMediaIntakeText(
      req.body?.confirmation,
      200
    );

    if (confirmation !== "REMOVE FROM AGV") {
      return res.status(400).json({
        ok: false,
        error:
          "Super Admin confirmation phrase REMOVE FROM AGV is required",
      });
    }

    const isPartnerSubmission =
      lookup.intake?.source ===
        "AGV_CONTENT_PARTNER_PORTAL" ||
      Boolean(lookup.intake?.partnerSubmissionId);

    if (isPartnerSubmission) {
      return res.status(409).json({
        ok: false,
        error:
          "Partner Portal submissions must be removed through the protected Partner workflow",
      });
    }

    const intakeId = lookup.intake.intakeId;
    const removedTitle =
      lookup.intake.title ||
      lookup.intake.filename ||
      intakeId;

    const storedPath =
      getControlledMediaStoredPath(lookup.intake);

    let quarantinedPath = "";

    if (storedPath && fs.existsSync(storedPath)) {
      quarantinedPath =
        storedPath +
        ".agv-removal-" +
        Date.now();

      try {
        fs.renameSync(
          storedPath,
          quarantinedPath
        );
      } catch (error) {
        return res.status(500).json({
          ok: false,
          error:
            "The stored media file could not be secured for removal",
        });
      }
    }

    const remainingIntakes =
      lookup.mediaIntakes.filter(
        (entry) => entry.intakeId !== intakeId
      );

    try {
      saveMediaIntakes(remainingIntakes);
    } catch (error) {
      if (
        quarantinedPath &&
        fs.existsSync(quarantinedPath)
      ) {
        try {
          fs.renameSync(
            quarantinedPath,
            storedPath
          );
        } catch (rollbackError) {
          console.error(
            "MEDIA REMOVAL FILE ROLLBACK FAILED:",
            rollbackError.message
          );
        }
      }

      console.error(
        "MEDIA REMOVAL REGISTRY SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "The media record could not be removed from the AGV registry",
      });
    }

    if (
      quarantinedPath &&
      fs.existsSync(quarantinedPath)
    ) {
      removeControlledUploadFile(
        quarantinedPath
      );
    }

    for (
      const [ticket, ticketRecord]
      of controlledMediaPreviewTickets.entries()
    ) {
      if (ticketRecord?.intakeId === intakeId) {
        controlledMediaPreviewTickets.delete(
          ticket
        );
      }
    }

    console.log(
      "SUPER ADMIN MEDIA REMOVED:",
      intakeId,
      removedTitle
    );

    return res.json({
      ok: true,
      removed: true,
      intakeId,
      title: removedTitle,
      externalSourcePreserved:
        lookup.intake?.sourceType ===
        "YOUTUBE",
      message:
        "Media was permanently removed from AGV. External source content was not deleted.",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/approve",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      lookup.intake.status !==
      "UPLOADED_PENDING_REVIEW"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Only pending-review media can be approved",
        status: lookup.intake.status,
      });
    }

    const now = new Date().toISOString();
    const actor =
      getControlledMediaReviewActor(req);

    const approvalNote =
      cleanMediaIntakeText(
        req.body?.note,
        1000
      );

    const updatedIntake = {
      ...lookup.intake,

      status:
        "APPROVED_FOR_PRIVATE_PUBLISHING",

      updatedAt: now,
      reviewedAt: now,

      review: {
        decision: "APPROVED",
        note: approvalNote,
        reviewedAt: now,
        reviewedBy: actor,
      },
    };

    let syncResult;

    try {
      syncResult =
        saveFounderDecisionWithPartnerSync({
          intakeLookup: lookup,
          updatedIntake,
          decision: "APPROVED",
          decisionNote: approvalNote,
          rejectionReason: "",
          reviewedAt: now,
          reviewedBy: actor,
        });
    } catch (error) {
      console.error(
        "MEDIA/PARTNER REVIEW APPROVAL SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not synchronize the Founder approval decision",
      });
    }

    return res.json({
      ok: true,

      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,

      partnerSynchronized:
        syncResult.partnerSynchronized,

      partnerStatus:
        syncResult.partnerSubmission?.status ||
        null,

      partnerSubmission:
        syncResult.partnerSubmission,

      publicAccess: false,
      automaticPublication: false,

      message:
        syncResult.partnerSynchronized
          ? "Media approved and the linked Partner submission was synchronized for private Founder-controlled publishing"
          : "Media approved for private Founder-controlled publishing",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/reject",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      lookup.intake.status !==
      "UPLOADED_PENDING_REVIEW"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Only pending-review media can be rejected",
        status: lookup.intake.status,
      });
    }

    const reason = cleanMediaIntakeText(
      req.body?.reason,
      1000
    );

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error: "A rejection reason is required",
      });
    }

    const now = new Date().toISOString();
    const actor =
      getControlledMediaReviewActor(req);

    const updatedIntake = {
      ...lookup.intake,

      status: "REJECTED_BY_FOUNDER",

      updatedAt: now,
      reviewedAt: now,

      review: {
        decision: "REJECTED",
        reason,
        reviewedAt: now,
        reviewedBy: actor,
      },
    };

    let syncResult;

    try {
      syncResult =
        saveFounderDecisionWithPartnerSync({
          intakeLookup: lookup,
          updatedIntake,
          decision: "REJECTED",
          decisionNote: "",
          rejectionReason: reason,
          reviewedAt: now,
          reviewedBy: actor,
        });
    } catch (error) {
      console.error(
        "MEDIA/PARTNER REVIEW REJECTION SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not synchronize the Founder rejection decision",
      });
    }

    return res.json({
      ok: true,

      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,

      partnerSynchronized:
        syncResult.partnerSynchronized,

      partnerStatus:
        syncResult.partnerSubmission?.status ||
        null,

      partnerSubmission:
        syncResult.partnerSubmission,

      publicAccess: false,
      automaticPublication: false,

      message:
        syncResult.partnerSynchronized
          ? "Media rejected and the linked Partner submission was synchronized"
          : "Media rejected by the Founder",
    });
  }
);

// PASS CU-10C FOUNDER PRIVATE PREVIEW STREAMING
function getControlledMediaStoredPath(intake) {
  const storedFilename = path.basename(
    String(intake?.upload?.storedFilename || "")
  );

  if (!storedFilename) {
    return null;
  }

  const storedPath = path.join(
    CONTROLLED_MEDIA_UPLOAD_DIR,
    storedFilename
  );

  const normalizedUploadRoot =
    path.resolve(CONTROLLED_MEDIA_UPLOAD_DIR) +
    path.sep;

  const normalizedStoredPath = path.resolve(storedPath);

  if (!normalizedStoredPath.startsWith(normalizedUploadRoot)) {
    return null;
  }

  return normalizedStoredPath;
}

function getControlledMediaPreviewContentType(intake) {
  const storedFilename = String(
    intake?.upload?.storedFilename || intake?.filename || ""
  );

  const extension = path.extname(storedFilename).toLowerCase();

  const contentTypes = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".webm": "video/webm",
  };

  return (
    contentTypes[extension] ||
    cleanMediaIntakeText(
      intake?.upload?.mimetype || intake?.mimetype,
      150
    ) ||
    "application/octet-stream"
  );
}

function purgeExpiredControlledMediaPreviewTickets() {
  const now = Date.now();

  for (const [ticket, record] of controlledMediaPreviewTickets) {
    if (!record || Number(record.expiresAt) <= now) {
      controlledMediaPreviewTickets.delete(ticket);
    }
  }
}

app.post(
  "/api/media/review/:intakeId/preview-ticket",
  requireControlledMediaSuperadmin,
  (req, res) => {
    purgeExpiredControlledMediaPreviewTickets();

    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const allowedStatuses = new Set([
      "UPLOADED_PENDING_REVIEW",
      "APPROVED_FOR_PRIVATE_PUBLISHING",
      "REJECTED_BY_FOUNDER",
      "PUBLISHED_PRIVATE_TEST",
      "PUBLICATION_READY_STAGED",
      "PUBLISHED_PUBLIC",
      "UNPUBLISHED",
    ]);

    if (!allowedStatuses.has(lookup.intake.status)) {
      return res.status(409).json({
        ok: false,
        error: "This intake is not available for Founder preview",
        status: lookup.intake.status,
      });
    }

    const storedPath = getControlledMediaStoredPath(
      lookup.intake
    );

    if (!storedPath || !fs.existsSync(storedPath)) {
      return res.status(404).json({
        ok: false,
        error: "The stored media file was not found",
      });
    }

    const ticket = crypto.randomBytes(32).toString(
      "hex"
    );

    const expiresAt =
      Date.now() + CONTROLLED_MEDIA_PREVIEW_TICKET_TTL_MS;

    controlledMediaPreviewTickets.set(ticket, {
      intakeId: lookup.intake.intakeId,
      expiresAt,
      createdBy: getControlledMediaReviewActor(req),
    });

    return res.json({
      ok: true,
      intakeId: lookup.intake.intakeId,
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
      expiresInSeconds: Math.floor(
        CONTROLLED_MEDIA_PREVIEW_TICKET_TTL_MS / 1000
      ),
      previewPath:
        "/api/media/review/" +
        encodeURIComponent(lookup.intake.intakeId) +
        "/preview?ticket=" +
        encodeURIComponent(ticket),
    });
  }
);

app.get(
  "/api/media/review/:intakeId/preview",
  (req, res) => {
    purgeExpiredControlledMediaPreviewTickets();

    const intakeId = cleanMediaIntakeText(
      req.params?.intakeId,
      100
    );

    const ticket = cleanMediaIntakeText(
      req.query?.ticket,
      200
    );

    const ticketRecord =
      controlledMediaPreviewTickets.get(ticket);

    if (
      !ticket ||
      !ticketRecord ||
      ticketRecord.intakeId !== intakeId ||
      Number(ticketRecord.expiresAt) <= Date.now()
    ) {
      controlledMediaPreviewTickets.delete(ticket);

      return res.status(401).json({
        ok: false,
        error: "The Founder preview ticket is invalid or expired",
      });
    }

    const lookup = findControlledMediaIntakeById(intakeId);

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const storedPath = getControlledMediaStoredPath(
      lookup.intake
    );

    if (!storedPath || !fs.existsSync(storedPath)) {
      return res.status(404).json({
        ok: false,
        error: "The stored media file was not found",
      });
    }

    let fileStat;

    try {
      fileStat = fs.statSync(storedPath);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "Could not read the stored media file",
      });
    }

    if (!fileStat.isFile() || fileStat.size < 1) {
      return res.status(404).json({
        ok: false,
        error: "The stored media file is unavailable",
      });
    }

    const fileSize = fileStat.size;
    const contentType =
      getControlledMediaPreviewContentType(lookup.intake);
    const rangeHeader = String(req.headers.range || "");

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (!rangeHeader) {
      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", fileSize);

      return fs.createReadStream(storedPath).pipe(res);
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(
      rangeHeader.trim()
    );

    if (!rangeMatch) {
      res.status(416);
      res.setHeader("Content-Range", "bytes */" + fileSize);
      return res.end();
    }

    let start;
    let end;

    if (rangeMatch[1] === "" && rangeMatch[2] !== "") {
      const suffixLength = Number(rangeMatch[2]);

      if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
        res.status(416);
        res.setHeader("Content-Range", "bytes */" + fileSize);
        return res.end();
      }

      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else {
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] === ""
        ? fileSize - 1
        : Number(rangeMatch[2]);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      res.status(416);
      res.setHeader("Content-Range", "bytes */" + fileSize);
      return res.end();
    }

    end = Math.min(end, fileSize - 1);
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", chunkSize);
    res.setHeader(
      "Content-Range",
      "bytes " + start + "-" + end + "/" + fileSize
    );

    return fs
      .createReadStream(storedPath, { start, end })
      .pipe(res);
  }
);

// PASS CU-10G2 CONTROLLED PUBLIC RIGHTS CLEARANCE FOUNDATION
// Rights readiness only. No public publishing or public playback.

const CONTROLLED_MEDIA_RIGHTS_BASES = new Set([
  "OWNED_ORIGINAL",
  "LICENSED",
  "WRITTEN_PERMISSION",
  "PUBLIC_DOMAIN",
  "GOVERNMENT_WORK",
]);

function getControlledMediaRightsEligibility(intake) {
  const storedPath = getControlledMediaStoredPath(intake);

  return {
    rightsCleared:
      intake?.rightsClearance?.status ===
      "CLEARED_FOR_PUBLIC_PUBLISHING",
    founderApproved:
      intake?.review?.decision === "APPROVED",
    storedFileVerified:
      Boolean(storedPath) && fs.existsSync(storedPath),
    privatePublicationActive:
      intake?.status === "PUBLISHED_PRIVATE_TEST",
    eligibleForFuturePublicPublishing:
      intake?.rightsClearance?.status ===
        "CLEARED_FOR_PUBLIC_PUBLISHING" &&
      intake?.review?.decision === "APPROVED" &&
      Boolean(storedPath) &&
      fs.existsSync(storedPath),
  };
}

function appendControlledMediaRightsAudit(
  intake,
  action,
  actor,
  details = {}
) {
  const history = Array.isArray(intake?.rightsAudit)
    ? intake.rightsAudit
    : [];

  return [
    ...history,
    {
      action,
      occurredAt: new Date().toISOString(),
      actor,
      details,
    },
  ].slice(-100);
}

app.get(
  "/api/media/rights",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const items = loadMediaIntakes()
      .filter((entry) =>
        Boolean(entry?.upload?.storedFilename)
      )
      .map((entry) => ({
        intakeId: entry.intakeId,
        title: entry.title,
        filename: entry.filename,
        status: entry.status,
        reviewDecision:
          entry?.review?.decision || "",
        rightsClearance:
          entry.rightsClearance || {
            status: "NOT_SUBMITTED",
          },
        eligibility:
          getControlledMediaRightsEligibility(entry),
        updatedAt: entry.updatedAt,
      }))
      .sort((left, right) =>
        String(right.updatedAt || "").localeCompare(
          String(left.updatedAt || "")
        )
      );

    return res.json({
      ok: true,
      count: items.length,
      items,
      publicPublishingEnabled: false,
    });
  }
);

// PASS FAD-01 - FOUNDER ADMIN HUMAN REVIEW DECISION
// This route records a protected Founder/Super Admin decision for
// Partner or outside content. It does not publish the media directly.
const FOUNDER_ADMIN_DECISION_BASES = new Set([
  "OFFICIAL_PROVIDER_EMBED",
  "PUBLIC_DOMAIN",
  "GOVERNMENT_WORK",
  "LICENSED",
  "WRITTEN_PERMISSION",
]);

app.post(
  "/api/media/review/:intakeId/founder-admin-decision",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup =
      findControlledMediaIntakeById(
        req.params?.intakeId
      );

    if (!lookup.ok) {
      return res
        .status(lookup.statusCode)
        .json({
          ok: false,
          error: lookup.error,
        });
    }

    if (
      isControlledPartnerPublishingBlocked(
        lookup.intake
      )
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "This Partner media is under an AGV takedown hold. A Founder Admin Decision cannot restore publication eligibility until the hold is resolved.",
        moderationStatus:
          lookup.intake?.moderationStatus ||
          "PARTNER_TAKEDOWN_HOLD",
      });
    }

    const partnerOrigin =
      lookup.intake?.source ===
        "AGV_CONTENT_PARTNER_PORTAL" ||
      Boolean(
        lookup.intake?.partnerSubmissionId
      );

    const founderOwnedOriginal =
      lookup.intake?.source ===
        "AGV_FOUNDER_CONTROLLED_INTAKE" &&
      !partnerOrigin;

    if (founderOwnedOriginal) {
      return res.status(409).json({
        ok: false,
        error:
          "Founder-owned originals use the protected Founder self-certification workflow, not the outside-content Admin Decision route.",
      });
    }

    const decisionBasis =
      cleanMediaIntakeText(
        req.body?.decisionBasis,
        100
      )
        .trim()
        .toUpperCase();

    if (
      !FOUNDER_ADMIN_DECISION_BASES.has(
        decisionBasis
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Select a valid Founder Admin Decision basis",
        allowedBases:
          Array.from(
            FOUNDER_ADMIN_DECISION_BASES
          ),
      });
    }

    const evidenceReference =
      cleanMediaIntakeText(
        req.body?.evidenceReference,
        1500
      );

    const sourceUrl =
      cleanMediaIntakeText(
        req.body?.sourceUrl ||
          lookup.intake?.sourceUrl ||
          lookup.intake?.youtubeUrl ||
          lookup.intake
            ?.directSourceUrl,
        1500
      );

    if (
      !evidenceReference &&
      !sourceUrl
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "A rights evidence reference or official source URL is required",
      });
    }

    const founderDecisionNote =
      cleanMediaIntakeText(
        req.body?.founderDecisionNote,
        2000
      );

    if (
      founderDecisionNote.length < 10
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Enter a meaningful Founder review decision of at least 10 characters",
      });
    }

    const confirmation =
      cleanMediaIntakeText(
        req.body?.confirmation,
        200
      );

    if (
      confirmation !==
      "SAVE FOUNDER ADMIN DECISION"
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Founder confirmation phrase SAVE FOUNDER ADMIN DECISION is required",
      });
    }

    const attribution =
      cleanMediaIntakeText(
        req.body?.attribution ||
          lookup.intake?.rightsClearance
            ?.attribution ||
          lookup.intake?.attribution ||
          lookup.intake?.provider,
        500
      );

    if (!attribution) {
      return res.status(400).json({
        ok: false,
        error:
          "Provider attribution is required for Partner or outside content",
      });
    }

    const certificationStatement =
      cleanMediaIntakeText(
        req.body?.certificationStatement,
        2000
      );

    if (
      certificationStatement.length <
      20
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Enter a Founder human-review attestation of at least 20 characters",
      });
    }

    const now =
      new Date().toISOString();

    const actor =
      getControlledMediaReviewActor(
        req
      );

    const priorReview =
      lookup.intake?.review || {};

    const priorRights =
      lookup.intake
        ?.rightsClearance || {};

    const founderAdminDecision = {
      decision:
        "APPROVED_FOR_AGV_PUBLICATION_ELIGIBILITY",

      decisionBasis,

      founderDecisionNote,

      evidenceReference:
        evidenceReference ||
        sourceUrl,

      sourceUrl,

      attribution,

      certificationStatement,

      reviewedAt: now,
      reviewedBy: actor,

      humanReview: true,

      directPublication:
        false,

      publicationStillRequires:
        "FOUNDER_PUBLIC_ACCESS_DECISION",
    };

    const updatedIntake = {
      ...lookup.intake,

      updatedAt: now,

      review: {
        ...priorReview,

        decision: "APPROVED",

        reviewedAt: now,
        reviewedBy: actor,

        approvalSource:
          "FOUNDER_ADMIN_HUMAN_REVIEW",

        founderAdminDecision:
          true,

        decisionNote:
          founderDecisionNote,
      },

      rightsClearance: {
        ...priorRights,

        status:
          "CLEARED_FOR_PUBLIC_PUBLISHING",

        rightsBasis:
          decisionBasis,

        evidenceReference:
          evidenceReference ||
          sourceUrl,

        sourceUrl,

        attribution,

        notes:
          founderDecisionNote,

        submittedAt:
          priorRights.submittedAt ||
          now,

        submittedBy:
          priorRights.submittedBy ||
          actor,

        clearedAt: now,
        clearedBy: actor,

        revokedAt: null,
        revokedBy: null,
        revocationReason: null,

        founderHumanReview:
          true,

        clearanceSource:
          "FOUNDER_ADMIN_DECISION",

        certification: {
          certifyAuthority: true,

          certifyEvidenceAccurate:
            true,

          certifyPublicUseAllowed:
            true,

          statement:
            certificationStatement,

          humanReview: true,
        },
      },

      founderAdminDecision,

      rightsAudit:
        appendControlledMediaRightsAudit(
          lookup.intake,

          "FOUNDER_ADMIN_DECISION_SAVED",

          actor,

          {
            decisionBasis,

            evidenceReference:
              evidenceReference ||
              sourceUrl,

            sourceUrl,

            attribution,

            founderDecisionNote,

            humanReview: true,

            directPublication:
              false,

            partnerOrigin,
          }
        ),
    };

    const originalIntake =
      lookup.intake;

    lookup.mediaIntakes[
      lookup.intakeIndex
    ] = updatedIntake;

    let originalSubmissions = null;
    let updatedPartnerSubmission =
      null;

    if (partnerOrigin) {
      const partnerSubmissionId =
        cleanContentPartnerText(
          lookup.intake
            ?.partnerSubmissionId,
          100
        );

      if (
        !partnerSubmissionId ||
        !/^AGV-CP-[A-Z0-9-]+$/i.test(
          partnerSubmissionId
        )
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "The linked Partner submission ID is invalid",
        });
      }

      originalSubmissions =
        loadContentPartnerSubmissions();

      const submissionIndex =
        originalSubmissions.findIndex(
          (entry) =>
            entry.submissionId ===
            partnerSubmissionId
        );

      if (submissionIndex < 0) {
        return res.status(409).json({
          ok: false,
          error:
            "The linked Partner submission was not found",
        });
      }

      const originalSubmission =
        originalSubmissions[
          submissionIndex
        ];

      if (
        originalSubmission?.upload
          ?.mediaIntakeId &&
        originalSubmission.upload
          .mediaIntakeId !==
          lookup.intake.intakeId
      ) {
        return res.status(409).json({
          ok: false,
          error:
            "The Partner submission and controlled media intake linkage could not be verified",
        });
      }

      updatedPartnerSubmission = {
        ...originalSubmission,

        updatedAt: now,

        status:
          "FOUNDER_ADMIN_REVIEW_APPROVED",

        review: {
          ...(originalSubmission.review ||
            {}),

          rightsCheck:
            "CLEARED_BY_FOUNDER_ADMIN_REVIEW",

          editorialReview:
            "FOUNDER_HUMAN_REVIEW_COMPLETE",

          approvalStatus:
            "APPROVED_BY_FOUNDER",

          networkPlacement:
            originalSubmission?.review
              ?.networkPlacement ||
            "NOT_STARTED",
        },

        founderAdminDecision: {
          ...founderAdminDecision,

          mediaIntakeId:
            lookup.intake.intakeId,
        },
      };

      originalSubmissions[
        submissionIndex
      ] = updatedPartnerSubmission;
    }

    try {
      saveMediaIntakes(
        lookup.mediaIntakes
      );
    } catch (error) {
      console.error(
        "FOUNDER ADMIN DECISION MEDIA SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the Founder Admin Decision",
      });
    }

    if (
      partnerOrigin &&
      originalSubmissions
    ) {
      try {
        saveContentPartnerSubmissions(
          originalSubmissions
        );
      } catch (error) {
        try {
          const rollbackIntakes =
            loadMediaIntakes();

          const rollbackIndex =
            rollbackIntakes.findIndex(
              (entry) =>
                entry.intakeId ===
                originalIntake.intakeId
            );

          if (rollbackIndex >= 0) {
            rollbackIntakes[
              rollbackIndex
            ] = originalIntake;

            saveMediaIntakes(
              rollbackIntakes
            );
          }
        } catch (
          rollbackError
        ) {
          console.error(
            "FOUNDER ADMIN DECISION ROLLBACK FAILED:",
            rollbackError.message
          );
        }

        console.error(
          "FOUNDER ADMIN DECISION PARTNER SAVE FAILED:",
          error.message
        );

        return res.status(500).json({
          ok: false,
          error:
            "The Founder Admin Decision was rolled back because the linked Partner submission could not be updated",
        });
      }
    }

    const readiness =
      getControlledMediaPublicReadiness(
        updatedIntake
      );

    console.log(
      "FOUNDER ADMIN DECISION SAVED:",
      updatedIntake.intakeId,
      decisionBasis,
      partnerOrigin
        ? "PARTNER"
        : "OUTSIDE_CONTENT"
    );

    return res.json({
      ok: true,

      intakeId:
        updatedIntake.intakeId,

      intake:
        updatedIntake,

      partnerSubmission:
        updatedPartnerSubmission
          ? safeContentPartnerSubmission(
              updatedPartnerSubmission
            )
          : null,

      founderAdminDecision,

      rightsClearance:
        updatedIntake
          .rightsClearance,

      readiness,

      publicAccess:
        updatedIntake
          .publicAccess === true,

      publishedImmediately:
        false,

      message:
        "Founder Admin Decision saved. Rights eligibility and Founder approval were recorded. Public activation still requires a separate Founder Public Access Decision.",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/rights/pending",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (!lookup.intake?.upload?.storedFilename) {
      return res.status(409).json({
        ok: false,
        error:
          "A completed secure upload is required before rights review",
      });
    }

    const rightsBasis = cleanMediaIntakeText(
      req.body?.rightsBasis,
      80
    ).toUpperCase();

    const evidenceReference = cleanMediaIntakeText(
      req.body?.evidenceReference,
      1500
    );

    if (!CONTROLLED_MEDIA_RIGHTS_BASES.has(rightsBasis)) {
      return res.status(400).json({
        ok: false,
        error:
          "A recognized rights basis is required",
        allowedRightsBases:
          Array.from(CONTROLLED_MEDIA_RIGHTS_BASES),
      });
    }

    if (!evidenceReference) {
      return res.status(400).json({
        ok: false,
        error:
          "A rights evidence reference is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const rightsClearance = {
      status: "RIGHTS_CLEARANCE_PENDING",
      rightsBasis,
      licenseType: cleanMediaIntakeText(
        req.body?.licenseType,
        200
      ),
      licenseUrl: cleanMediaIntakeText(
        req.body?.licenseUrl,
        1500
      ),
      sourceUrl: cleanMediaIntakeText(
        req.body?.sourceUrl,
        1500
      ),
      evidenceReference,
      attribution: cleanMediaIntakeText(
        req.body?.attribution ||
          lookup.intake.attribution,
        500
      ),
      notes: cleanMediaIntakeText(
        req.body?.notes,
        1500
      ),
      submittedAt: now,
      submittedBy: actor,
      clearedAt: null,
      clearedBy: null,
      revokedAt: null,
      revokedBy: null,
    };

    const updatedIntake = {
      ...lookup.intake,
      updatedAt: now,
      rightsClearance,
      rightsAudit: appendControlledMediaRightsAudit(
        lookup.intake,
        "RIGHTS_SUBMITTED_FOR_REVIEW",
        actor,
        { rightsBasis }
      ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "RIGHTS REVIEW SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the rights-review submission",
      });
    }

    return res.json({
      ok: true,
      intake: updatedIntake,
      rightsClearance,
      eligibility:
        getControlledMediaRightsEligibility(updatedIntake),
      publicPublishingEnabled: false,
      message:
        "Media submitted for controlled rights review",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/rights/clear",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      lookup.intake?.rightsClearance?.status !==
      "RIGHTS_CLEARANCE_PENDING"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Rights evidence must be submitted before Founder clearance",
        rightsStatus:
          lookup.intake?.rightsClearance?.status ||
          "NOT_SUBMITTED",
      });
    }

    if (
      req.body?.certifyAuthority !== true ||
      req.body?.certifyEvidenceAccurate !== true ||
      req.body?.certifyPublicUseAllowed !== true
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "All Founder rights certifications must be affirmed",
      });
    }

    const certificationStatement = cleanMediaIntakeText(
      req.body?.certificationStatement,
      1500
    );

    if (!certificationStatement) {
      return res.status(400).json({
        ok: false,
        error:
          "A Founder certification statement is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const updatedIntake = {
      ...lookup.intake,
      updatedAt: now,
      rightsClearance: {
        ...lookup.intake.rightsClearance,
        status: "CLEARED_FOR_PUBLIC_PUBLISHING",
        clearedAt: now,
        clearedBy: actor,
        certification: {
          certifyAuthority: true,
          certifyEvidenceAccurate: true,
          certifyPublicUseAllowed: true,
          statement: certificationStatement,
        },
      },
      rightsAudit: appendControlledMediaRightsAudit(
        lookup.intake,
        "RIGHTS_CLEARED_BY_FOUNDER",
        actor,
        {
          rightsBasis:
            lookup.intake.rightsClearance.rightsBasis,
        }
      ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "RIGHTS CLEARANCE SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the Founder rights clearance",
      });
    }

    return res.json({
      ok: true,
      intake: updatedIntake,
      rightsClearance:
        updatedIntake.rightsClearance,
      eligibility:
        getControlledMediaRightsEligibility(updatedIntake),
      publicPublishingEnabled: false,
      message:
        "Rights cleared for a future controlled public-publishing pass",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/rights/revoke",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const reason = cleanMediaIntakeText(
      req.body?.reason,
      1500
    );

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error:
          "A rights-revocation reason is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const updatedIntake = {
      ...lookup.intake,
      updatedAt: now,
      rightsClearance: {
        ...(lookup.intake.rightsClearance || {}),
        status: "RIGHTS_REVOKED",
        revokedAt: now,
        revokedBy: actor,
        revocationReason: reason,
      },
      rightsAudit: appendControlledMediaRightsAudit(
        lookup.intake,
        "RIGHTS_REVOKED",
        actor,
        { reason }
      ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "RIGHTS REVOCATION SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the rights revocation",
      });
    }

    return res.json({
      ok: true,
      intake: updatedIntake,
      rightsClearance:
        updatedIntake.rightsClearance,
      eligibility:
        getControlledMediaRightsEligibility(updatedIntake),
      publicPublishingEnabled: false,
      message:
        "Public-publishing eligibility has been revoked",
    });
  }
);

// PASS CU-10H3A INACTIVE CONTROLLED PUBLIC PLAYBACK
// Playback remains inaccessible until a later Founder activation pass.

function isControlledMediaPubliclyActive(intake) {
  return Boolean(
    intake &&
      intake.status === "PUBLISHED_PUBLIC" &&
      intake.publicAccess === true &&
      intake?.rightsClearance?.status === "CLEARED_FOR_PUBLIC_PUBLISHING" &&
      intake?.review?.decision === "APPROVED" &&
      intake?.publicPublication?.registryStatus === "PUBLISHED_PUBLIC" &&
      intake?.publicPublication?.active === true &&
      intake?.publicPublication?.publicAccess === true &&
      intake?.publicPublication?.playbackEnabled === true &&
      intake?.publicPublication?.emergencyBlocked !== true
  );
}

// PASS YTI-01 - FOUNDER YOUTUBE ON DEMAND INTAKE
function getControlledMediaExternalYouTube(intake) {
  const sourceType = String(
    intake?.sourceType ||
      intake?.externalMedia?.sourceType ||
      ""
  )
    .trim()
    .toUpperCase();

  const videoId = String(
    intake?.videoId ||
      intake?.externalMedia?.videoId ||
      ""
  ).trim();

  if (
    sourceType !== "YOUTUBE" ||
    !/^[A-Za-z0-9_-]{11}$/.test(videoId)
  ) {
    return null;
  }

  const sourceUrl = String(
    intake?.sourceUrl ||
      intake?.externalMedia?.sourceUrl ||
      "https://youtu.be/" + videoId
  ).trim();

  const embedUrl = String(
    intake?.embedUrl ||
      intake?.externalMedia?.embedUrl ||
      "https://www.youtube-nocookie.com/embed/" +
        encodeURIComponent(videoId) +
        "?autoplay=1&playsinline=1&controls=1&fs=1&rel=0"
  ).trim();

  const thumbnail = String(
    intake?.thumbnail ||
      intake?.externalMedia?.thumbnail ||
      "https://i.ytimg.com/vi/" +
        encodeURIComponent(videoId) +
        "/hqdefault.jpg"
  ).trim();

  return {
    sourceType: "YOUTUBE",
    playbackMode: "YOUTUBE_EXTERNAL",
    videoId,
    sourceUrl,
    embedUrl,
    thumbnail,
  };
}

// PASS PLEX-01 - CONTROLLED EXTERNAL LINK LISTINGS
// External guide entries never receive an AGV playback route.
function getControlledMediaExternalRedirect(intake) {
  const sourceType = String(
    intake?.sourceType ||
      intake?.externalLink?.sourceType ||
      intake?.externalMedia?.sourceType ||
      ""
  )
    .trim()
    .toUpperCase();

  const playbackMode = String(
    intake?.playbackMode ||
      intake?.externalLink?.playbackMode ||
      intake?.externalMedia?.playbackMode ||
      ""
  )
    .trim()
    .toUpperCase();

  const rightsStatus = String(
    intake?.rightsStatus ||
      intake?.rightsClearance?.status ||
      intake?.externalLink?.rightsStatus ||
      ""
  )
    .trim()
    .toUpperCase();

  if (
    sourceType !== "PLEX_EXTERNAL_LINK" ||
    playbackMode !== "EXTERNAL_REDIRECT" ||
    rightsStatus !==
      "LINK_ONLY_NO_AGV_PLAYBACK"
  ) {
    return null;
  }

  const rawExternalUrl = String(
    intake?.externalUrl ||
      intake?.destinationUrl ||
      intake?.externalLink?.externalUrl ||
      intake?.externalMedia?.externalUrl ||
      ""
  ).trim();

  if (!rawExternalUrl) {
    return null;
  }

  let parsed;

  try {
    parsed = new URL(rawExternalUrl);
  } catch {
    return null;
  }

  const allowedHosts = new Set([
    "watch.plex.tv",
    "l.plex.tv",
  ]);

  if (
    parsed.protocol !== "https:" ||
    !allowedHosts.has(
      parsed.hostname.toLowerCase()
    )
  ) {
    return null;
  }

  const thumbnail = String(
    intake?.thumbnail ||
      intake?.thumbnailUrl ||
      intake?.externalLink?.thumbnail ||
      ""
  ).trim();

  return {
    sourceType:
      "PLEX_EXTERNAL_LINK",

    playbackMode:
      "EXTERNAL_REDIRECT",

    rightsStatus:
      "LINK_ONLY_NO_AGV_PLAYBACK",

    provider: "Plex",

    externalUrl:
      parsed.href,

    buttonLabel:
      "View on Plex",

    thumbnail,

    noAgvPlayback: true,
    noEmbed: true,
    noDownload: true,
    noRestream: true,
  };
}

function getControlledMediaPublicPlaybackPath(intake) {
  if (!intake?.intakeId) {
    return null;
  }

  if (
    getControlledMediaExternalYouTube(intake) ||
    getControlledMediaExternalRedirect(intake)
  ) {
    return null;
  }

  return (
    "/api/media/public/" +
    encodeURIComponent(intake.intakeId) +
    "/playback"
  );
}

function isControlledExternalLinkPubliclyActive(
  intake
) {
  const redirect =
    getControlledMediaExternalRedirect(
      intake
    );

  return Boolean(
    redirect &&
      intake?.status ===
        "PUBLISHED_PUBLIC" &&
      intake?.visibility === "Public" &&
      intake?.publicAccess === true &&
      intake?.publicPublication
        ?.registryStatus ===
        "PUBLISHED_PUBLIC" &&
      intake?.publicPublication
        ?.active === true &&
      intake?.publicPublication
        ?.publicAccess === true &&
      intake?.publicPublication
        ?.playbackEnabled === false &&
      intake?.publicPublication
        ?.externalRedirectEnabled ===
        true &&
      intake?.publicPublication
        ?.emergencyBlocked !== true
  );
}

// PASS PROD-OD-01 — PRODUCTION PUBLIC ON DEMAND CATALOG
// Hosted Render instances use a committed snapshot containing only
// records already approved by the existing public media API.
app.get("/api/media/public", (req, res, next) => {
  const hostedProduction =
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";

  if (
    !hostedProduction ||
    !fs.existsSync(PUBLIC_MEDIA_CATALOG_FILE)
  ) {
    return next();
  }

  try {
    const snapshot = JSON.parse(
      fs.readFileSync(PUBLIC_MEDIA_CATALOG_FILE, "utf8")
    );

    const items = Array.isArray(snapshot?.items)
      ? snapshot.items
      : [];

    return res.json({
      ok: true,
      count: items.length,
      items,
      source: "PRODUCTION_PUBLIC_MEDIA_SNAPSHOT",
      generatedAt: snapshot?.generatedAt || null,
    });
  } catch (error) {
    console.error(
      "PRODUCTION PUBLIC MEDIA SNAPSHOT FAILED:",
      error.message
    );

    return next();
  }
});

app.get(
  "/api/media/public",
  (req, res) => {
    const items = loadMediaIntakes()
      .filter(
        (entry) =>
          isControlledMediaPubliclyActive(
            entry
          ) ||
          isControlledExternalLinkPubliclyActive(
            entry
          )
      )
      .map((entry) => ({
        intakeId: entry.intakeId,
        title:
          entry?.publicPublication?.publicTitle ||
          entry.title,
        description:
          entry?.publicPublication?.publicDescription ||
          "",
        attribution:
          entry?.publicPublication?.publicAttribution ||
          entry?.rightsClearance?.attribution ||
          entry.attribution ||
          "",
        rightsBasis:
          entry?.rightsClearance?.rightsBasis ||
          "",
        licenseType:
          entry?.rightsClearance?.licenseType ||
          "",
        publishedAt:
          entry?.publicPublication?.publishedAt ||
          entry.publishedAt ||
          null,
        sourceType:
          getControlledMediaExternalRedirect(entry)
            ?.sourceType ||
          getControlledMediaExternalYouTube(entry)
            ?.sourceType ||
          "AGV_HOSTED_MEDIA",
        playbackMode:
          getControlledMediaExternalRedirect(entry)
            ?.playbackMode ||
          getControlledMediaExternalYouTube(entry)
            ?.playbackMode ||
          "AGV_HOSTED_MEDIA",
        videoId:
          getControlledMediaExternalYouTube(entry)
            ?.videoId || null,
        sourceUrl:
          getControlledMediaExternalRedirect(entry)
            ?.externalUrl ||
          getControlledMediaExternalYouTube(entry)
            ?.sourceUrl ||
          null,
        embedUrl:
          getControlledMediaExternalYouTube(entry)
            ?.embedUrl || null,
        thumbnail:
          getControlledMediaExternalRedirect(entry)
            ?.thumbnail ||
          getControlledMediaExternalYouTube(entry)
            ?.thumbnail ||
          entry?.thumbnail ||
          entry?.thumbnailUrl ||
          null,
        externalUrl:
          getControlledMediaExternalRedirect(entry)
            ?.externalUrl ||
          null,

        buttonLabel:
          getControlledMediaExternalRedirect(entry)
            ?.buttonLabel ||
          null,

        rightsStatus:
          getControlledMediaExternalRedirect(entry)
            ?.rightsStatus ||
          entry?.rightsClearance?.status ||
          null,

        category:
          entry?.category || "",

        noAgvPlayback:
          getControlledMediaExternalRedirect(entry)
            ?.noAgvPlayback === true,

        playbackPath:
          getControlledMediaPublicPlaybackPath(entry),
      }))
      .sort((left, right) =>
        String(right.publishedAt || "").localeCompare(
          String(left.publishedAt || "")
        )
      );

    res.setHeader(
      "Cache-Control",
      "public, max-age=30, must-revalidate"
    );

    return res.json({
      ok: true,
      count: items.length,
      items,
    });
  }
);

app.get(
  "/api/media/public/:intakeId/playback",
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(404).json({
        ok: false,
        error: "Public media item not found",
      });
    }

    if (!isControlledMediaPubliclyActive(lookup.intake)) {
      return res.status(404).json({
        ok: false,
        error: "Public media item not found",
      });
    }

    const storedPath = getControlledMediaStoredPath(
      lookup.intake
    );

    if (!storedPath || !fs.existsSync(storedPath)) {
      return res.status(404).json({
        ok: false,
        error: "Public media file is unavailable",
      });
    }

    let fileStat;

    try {
      fileStat = fs.statSync(storedPath);
    } catch (error) {
      return res.status(404).json({
        ok: false,
        error: "Public media file is unavailable",
      });
    }

    if (
      !fileStat.isFile() ||
      fileStat.size !== Number(lookup.intake.filesize)
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Public media file failed integrity verification",
      });
    }

    const fileSize = fileStat.size;
    const contentType =
      getControlledMediaPreviewContentType(lookup.intake);
    const rangeHeader = String(req.headers.range || "");

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader(
      "Cache-Control",
      "public, max-age=300, must-revalidate"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      "inline"
    );

    if (!rangeHeader) {
      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", fileSize);

      return fs.createReadStream(storedPath).pipe(res);
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(
      rangeHeader.trim()
    );

    if (!rangeMatch) {
      res.status(416);
      res.setHeader(
        "Content-Range",
        "bytes */" + fileSize
      );
      return res.end();
    }

    let start;
    let end;

    if (rangeMatch[1] === "" && rangeMatch[2] !== "") {
      const suffixLength = Number(rangeMatch[2]);

      if (
        !Number.isSafeInteger(suffixLength) ||
        suffixLength < 1
      ) {
        res.status(416);
        res.setHeader(
          "Content-Range",
          "bytes */" + fileSize
        );
        return res.end();
      }

      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else {
      start = Number(rangeMatch[1]);
      end = rangeMatch[2] === ""
        ? fileSize - 1
        : Number(rangeMatch[2]);
    }

    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= fileSize
    ) {
      res.status(416);
      res.setHeader(
        "Content-Range",
        "bytes */" + fileSize
      );
      return res.end();
    }

    end = Math.min(end, fileSize - 1);
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", chunkSize);
    res.setHeader(
      "Content-Range",
      "bytes " + start + "-" + end + "/" + fileSize
    );

    return fs
      .createReadStream(storedPath, { start, end })
      .pipe(res);
  }
);

// PASS PTK-02 - PARTNER REPUBLISHING LOCK
function isControlledPartnerPublishingBlocked(intake) {
  const partnerOrigin =
    intake?.source ===
      "AGV_CONTENT_PARTNER_PORTAL" ||
    Boolean(intake?.partnerSubmissionId);

  if (!partnerOrigin) {
    return false;
  }

  return (
    intake?.partnerControls
      ?.publicPublishingBlocked === true ||
    intake?.partnerControls
      ?.suspendedByAgv === true ||
    intake?.moderationStatus ===
      "PARTNER_TAKEDOWN_HOLD" ||
    intake?.publicPublication
      ?.registryStatus ===
      "PARTNER_TAKEDOWN_HOLD"
  );
}

// PASS CU-10H3B FOUNDER PUBLIC ACTIVATION AND EMERGENCY UNPUBLISH
// Founder-only activation. Emergency unpublish immediately restores private-only access.

app.post(
  "/api/media/review/:intakeId/public-activate",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      isControlledPartnerPublishingBlocked(
        lookup.intake
      )
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "This Partner media is under an AGV takedown hold and cannot be publicly activated",
        moderationStatus:
          lookup.intake?.moderationStatus ||
          "PARTNER_TAKEDOWN_HOLD",
        publicPublishingBlocked: true,
      });
    }

    if (
      lookup.intake?.publicPublication?.registryStatus !==
      "STAGED_FOR_PUBLICATION" ||
      lookup.intake.status !== "PUBLICATION_READY_STAGED"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "The media must be staged in the controlled public registry before activation",
        status: lookup.intake.status,
        registryStatus:
          lookup.intake?.publicPublication?.registryStatus ||
          "NOT_STAGED",
      });
    }

    const readiness =
      getControlledMediaPublicReadiness(lookup.intake);

    if (!readiness.founderApproved) {
      return res.status(409).json({
        ok: false,
        error:
          "Founder media approval is required before public activation",
        readiness,
      });
    }

    if (!readiness.rightsCleared) {
      return res.status(409).json({
        ok: false,
        error:
          "Rights clearance is no longer valid for public activation",
        rightsStatus:
          lookup.intake?.rightsClearance?.status ||
          "NOT_SUBMITTED",
        readiness,
      });
    }

    if (!readiness.storedFileVerified) {
      return res.status(409).json({
        ok: false,
        error:
          "The stored media file failed final public-activation verification",
        readiness,
      });
    }

    const confirmation = cleanMediaIntakeText(
      req.body?.confirmation,
      200
    );

    if (confirmation !== "PUBLISH PUBLICLY") {
      return res.status(400).json({
        ok: false,
        error:
          "Founder confirmation phrase PUBLISH PUBLICLY is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);
    const playbackPath =
      getControlledMediaPublicPlaybackPath(lookup.intake);

    const updatedIntake = {
      ...lookup.intake,
      status: "PUBLISHED_PUBLIC",
      visibility: "Public",
      publicAccess: true,
      updatedAt: now,
      publicPublishedAt: now,
      publicPublication: {
        ...lookup.intake.publicPublication,
        registryStatus: "PUBLISHED_PUBLIC",
        active: true,
        publicAccess: true,
        playbackEnabled: true,
        publishedAt: now,
        publishedBy: actor,
        activatedAt: now,
        activatedBy: actor,
        destination:
          "AGV_NETWORK_ON_DEMAND_PUBLIC",
        playbackPath,
        permanentPublicUrl: null,
        emergencyBlocked: false,
        emergencyBlockedAt: null,
        emergencyBlockedBy: null,
        emergencyBlockReason: null,
      },
      publicationAudit:
        appendControlledMediaPublicationAudit(
          lookup.intake,
          "PUBLICATION_ACTIVATED_BY_FOUNDER",
          actor,
          {
            publicAccess: true,
            playbackEnabled: true,
            playbackPath,
            rightsStatus:
              lookup.intake.rightsClearance.status,
          }
        ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "PUBLIC ACTIVATION SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the controlled public activation",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      publicAccess: true,
      playbackEnabled: true,
      playbackPath,
      intake: updatedIntake,
      message:
        "Media is now publicly available through the controlled AGV Network playback route",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/emergency-unpublish",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (!isControlledMediaPubliclyActive(lookup.intake)) {
      return res.status(409).json({
        ok: false,
        error:
          "Only actively published public media can be emergency-unpublished",
        status: lookup.intake.status,
        publicAccess:
          lookup.intake.publicAccess === true,
      });
    }

    const reason = cleanMediaIntakeText(
      req.body?.reason,
      1500
    );

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error:
          "An emergency-unpublish reason is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const updatedIntake = {
      ...lookup.intake,
      status: "PUBLISHED_PRIVATE_TEST",
      visibility: "Private",
      publicAccess: false,
      updatedAt: now,
      publicUnpublishedAt: now,
      publicPublication: {
        ...lookup.intake.publicPublication,
        registryStatus: "EMERGENCY_UNPUBLISHED",
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        emergencyBlocked: true,
        emergencyBlockedAt: now,
        emergencyBlockedBy: actor,
        emergencyBlockReason: reason,
        unpublishedAt: now,
        unpublishedBy: actor,
        playbackPath: null,
        permanentPublicUrl: null,
      },
      publicationAudit:
        appendControlledMediaPublicationAudit(
          lookup.intake,
          "PUBLICATION_EMERGENCY_UNPUBLISHED",
          actor,
          {
            reason,
            publicAccess: false,
            playbackEnabled: false,
          }
        ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "EMERGENCY UNPUBLISH SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the emergency-unpublish decision",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      publicAccess: false,
      playbackEnabled: false,
      intake: updatedIntake,
      message:
        "Public access was stopped immediately. Owner-private access remains available.",
    });
  }
);

// PASS CU-10H2 CONTROLLED PUBLIC PUBLICATION REGISTRY FOUNDATION
// Registry staging only. Public playback and public access remain disabled.

function appendControlledMediaPublicationAudit(
  intake,
  action,
  actor,
  details = {}
) {
  const history = Array.isArray(intake?.publicationAudit)
    ? intake.publicationAudit
    : [];

  return [
    ...history,
    {
      action,
      occurredAt: new Date().toISOString(),
      actor,
      details,
    },
  ].slice(-100);
}

function getControlledMediaPublicReadiness(intake) {
  const storedPath = getControlledMediaStoredPath(intake);
  const externalYouTube =
    getControlledMediaExternalYouTube(intake);
  let storedFileVerified = Boolean(externalYouTube);
  let storedFileSize = null;

  if (
    !externalYouTube &&
    storedPath &&
    fs.existsSync(storedPath)
  ) {
    try {
      const stat = fs.statSync(storedPath);
      storedFileSize = stat.size;
      storedFileVerified =
        stat.isFile() &&
        stat.size === Number(intake?.filesize);
    } catch (error) {
      storedFileVerified = false;
    }
  }

  const founderApproved =
    intake?.review?.decision === "APPROVED";

  const rightsCleared =
    intake?.rightsClearance?.status ===
    "CLEARED_FOR_PUBLIC_PUBLISHING";

  const privatePublicationAvailable =
    intake?.status === "PUBLISHED_PRIVATE_TEST" ||
    intake?.status === "PUBLICATION_READY_STAGED";

  return {
    founderApproved,
    rightsCleared,
    storedFileVerified,
    storedFileSize,
    expectedFileSize: Number(intake?.filesize || 0),
    privatePublicationAvailable,
    eligibleForPublicRegistryStaging:
      founderApproved &&
      rightsCleared &&
      storedFileVerified &&
      privatePublicationAvailable,
  };
}

app.get(
  "/api/media/publication/registry",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const items = loadMediaIntakes()
      .filter((entry) =>
        Boolean(entry?.publicPublication)
      )
      .map((entry) => ({
        intakeId: entry.intakeId,
        title: entry.title,
        filename: entry.filename,
        status: entry.status,
        visibility: entry.visibility,
        publicAccess: entry.publicAccess === true,
        rightsClearance:
          entry.rightsClearance || null,
        readiness:
          getControlledMediaPublicReadiness(entry),
        publicPublication:
          entry.publicPublication,
        publicationAudit:
          Array.isArray(entry.publicationAudit)
            ? entry.publicationAudit
            : [],
        updatedAt: entry.updatedAt,
      }))
      .sort((left, right) =>
        String(right.updatedAt || "").localeCompare(
          String(left.updatedAt || "")
        )
      );

    return res.json({
      ok: true,
      count: items.length,
      items,
      publicPlaybackEnabled: false,
      publicAccessEnabled: false,
      registryMode: "FOUNDER_CONTROLLED_STAGING",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/public-stage",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      isControlledPartnerPublishingBlocked(
        lookup.intake
      )
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "This Partner media is under an AGV takedown hold and cannot be staged, scheduled, or republished",
        moderationStatus:
          lookup.intake?.moderationStatus ||
          "PARTNER_TAKEDOWN_HOLD",
        publicPublishingBlocked: true,
      });
    }

    // PASS FPA-04 - FOUNDER SUBMISSION IS THE AUTHORIZATION
    // A protected Founder publication request for an AGV Owned Original
    // records ownership certification in this same transaction.
    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const founderOwnedOriginalRequested =
      req.body?.founderOwnedOriginal === true;

    const partnerOrigin =
      lookup.intake?.source ===
        "AGV_CONTENT_PARTNER_PORTAL" ||
      Boolean(lookup.intake?.partnerSubmissionId);

    if (founderOwnedOriginalRequested && partnerOrigin) {
      return res.status(409).json({
        ok: false,
        error:
          "Partner submissions cannot use Founder-owned original self-certification",
      });
    }

    let effectiveIntake = lookup.intake;

    if (founderOwnedOriginalRequested) {
      const founderAttribution = cleanMediaIntakeText(
        req.body?.publicAttribution ||
          lookup.intake?.rightsClearance?.attribution ||
          lookup.intake?.attribution ||
          lookup.intake?.createdBy?.displayName ||
          "Avant Global Vision",
        500
      );

      effectiveIntake = {
        ...lookup.intake,
        source:
          lookup.intake?.source ||
          "AGV_FOUNDER_CONTROLLED_INTAKE",
        rightsConfirmed: true,
        review: {
          ...(lookup.intake?.review || {}),
          decision: "APPROVED",
          reviewedAt:
            lookup.intake?.review?.reviewedAt || now,
          reviewedBy:
            lookup.intake?.review?.reviewedBy || actor,
          approvalSource: "FOUNDER_PUBLICATION_REQUEST",
        },
        rightsClearance: {
          ...(lookup.intake?.rightsClearance || {}),
          status: "CLEARED_FOR_PUBLIC_PUBLISHING",
          rightsBasis: "OWNED_ORIGINAL",
          attribution: founderAttribution,
          certifiedAt: now,
          certifiedBy: actor,
          certificationSource:
            "FOUNDER_PUBLICATION_REQUEST",
          founderSelfCertified: true,
        },
        founderSubmission: {
          ...(lookup.intake?.founderSubmission || {}),
          ownedOriginal: true,
          selfCertifiedAt: now,
          selfCertifiedBy: actor,
        },
      };
    }

    const readiness =
      getControlledMediaPublicReadiness(effectiveIntake);

    if (!readiness.founderApproved) {
      return res.status(409).json({
        ok: false,
        error:
          "Founder media approval is required before public staging",
        readiness,
      });
    }

    if (!readiness.rightsCleared) {
      return res.status(409).json({
        ok: false,
        error:
          "CLEARED_FOR_PUBLIC_PUBLISHING rights status is required",
        rightsStatus:
          lookup.intake?.rightsClearance?.status ||
          "NOT_SUBMITTED",
        readiness,
      });
    }

    if (!readiness.storedFileVerified) {
      return res.status(409).json({
        ok: false,
        error:
          "The stored media file failed public-publication verification",
        readiness,
      });
    }

    if (!readiness.privatePublicationAvailable) {
      return res.status(409).json({
        ok: false,
        error:
          "The item must remain available in the controlled private publication workflow before public staging",
        status: lookup.intake.status,
        readiness,
      });
    }

    const publicationTitle = cleanMediaIntakeText(
      req.body?.publicTitle || effectiveIntake.title,
      300
    );
    const publicDescription = cleanMediaIntakeText(
      req.body?.publicDescription ||
        effectiveIntake.description,
      2000
    );
    const publicAttribution = cleanMediaIntakeText(
      req.body?.publicAttribution ||
        effectiveIntake?.rightsClearance?.attribution ||
        effectiveIntake.attribution,
      500
    );

    // PASS FPA-01 - FOUNDER PUBLIC ACCESS SCHEDULING FOUNDATION
    // Ownership verification remains separate and is preserved unchanged.
    const requestedPublishAt = cleanMediaIntakeText(
      req.body?.publishAt,
      100
    );

    let scheduledPublishAt = null;

    if (requestedPublishAt) {
      const parsedPublishAt = Date.parse(requestedPublishAt);

      if (
        !Number.isFinite(parsedPublishAt) ||
        parsedPublishAt <= Date.now()
      ) {
        return res.status(400).json({
          ok: false,
          error: "A valid future publishAt date and time is required",
        });
      }

      scheduledPublishAt = new Date(
        parsedPublishAt
      ).toISOString();
    }

    const updatedIntake = {
      ...effectiveIntake,
      status: "PUBLICATION_READY_STAGED",
      visibility: "Private",
      publicAccess: false,
      updatedAt: now,
      publicationControl: {
        ...(effectiveIntake.publicationControl || {}),
        mode: scheduledPublishAt ? "SCHEDULED" : "DISABLED",
        scheduledPublishAt,
        updatedAt: now,
        updatedBy: actor,
      },
      publicPublication: {
        ...(effectiveIntake.publicPublication || {}),
        registryStatus: "STAGED_FOR_PUBLICATION",
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        publicationMode: scheduledPublishAt ? "SCHEDULED" : "DISABLED",
        scheduledPublishAt,
        publicTitle: publicationTitle,
        publicDescription,
        publicAttribution,
        rightsStatus:
          effectiveIntake.rightsClearance.status,
        rightsBasis:
          effectiveIntake.rightsClearance.rightsBasis,
        stagedAt: now,
        stagedBy: actor,
        destination:
          "AGV_NETWORK_ON_DEMAND_PUBLIC_STAGING",
        permanentPublicUrl: null,
        playbackPath: null,
        emergencyBlocked: false,
        emergencyBlockedAt: null,
        emergencyBlockedBy: null,
        emergencyBlockReason: null,
      },
      publicationAudit:
        appendControlledMediaPublicationAudit(
          effectiveIntake,
          "PUBLICATION_STAGED_BY_FOUNDER",
          actor,
          {
            publicAccess: false,
            playbackEnabled: false,
            rightsStatus:
              effectiveIntake.rightsClearance.status,
          }
        ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "PUBLIC REGISTRY STAGING SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the controlled public-publication staging record",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,
      publicPublication:
        updatedIntake.publicPublication,
      publicAccess: false,
      publicPlaybackEnabled: false,
      message:
        "Media staged in the controlled public-publication registry. Public access remains disabled.",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/public-unstage",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      lookup.intake?.publicPublication?.registryStatus !==
      "STAGED_FOR_PUBLICATION"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Only a staged public-publication record can be removed from staging",
        registryStatus:
          lookup.intake?.publicPublication?.registryStatus ||
          "NOT_STAGED",
      });
    }

    const reason = cleanMediaIntakeText(
      req.body?.reason,
      1500
    );

    if (!reason) {
      return res.status(400).json({
        ok: false,
        error:
          "A public-publication unstage reason is required",
      });
    }

    const now = new Date().toISOString();
    const actor = getControlledMediaReviewActor(req);

    const updatedIntake = {
      ...lookup.intake,
      status: "PUBLISHED_PRIVATE_TEST",
      visibility: "Private",
      publicAccess: false,
      updatedAt: now,
      publicPublication: {
        ...lookup.intake.publicPublication,
        registryStatus: "UNSTAGED_BY_FOUNDER",
        active: false,
        publicAccess: false,
        playbackEnabled: false,
        unstagedAt: now,
        unstagedBy: actor,
        unstageReason: reason,
        permanentPublicUrl: null,
        playbackPath: null,
      },
      publicationAudit:
        appendControlledMediaPublicationAudit(
          lookup.intake,
          "PUBLICATION_UNSTAGED_BY_FOUNDER",
          actor,
          { reason }
        ),
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "PUBLIC REGISTRY UNSTAGE SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the controlled public-publication unstage record",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,
      publicAccess: false,
      publicPlaybackEnabled: false,
      message:
        "Media removed from public-publication staging. Owner-private access remains available.",
    });
  }
);

// PASS CU-10E2 PRIVATE AGV NETWORK PUBLISHING FOUNDATION
// PASS OML-01 - FOUNDER OWNER MEDIA LIBRARY
// Super Admin control across completed private, staged, public,
// and unpublished Founder-controlled media.

app.get(
  "/api/media/library/private",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const completedOwnerStatuses = new Set([
      "PUBLISHED_PRIVATE_TEST",
      "PUBLICATION_READY_STAGED",
      "PUBLISHED_PUBLIC",
      "UNPUBLISHED",
    ]);

    const items = loadMediaIntakes()
      .filter((entry) =>
        completedOwnerStatuses.has(entry.status)
      )
      .map((entry) => {
        const storedPath =
          getControlledMediaStoredPath(entry);

        const externalYouTube =
          getControlledMediaExternalYouTube(entry);

        const ownerPlaybackAvailable =
          Boolean(externalYouTube) ||
          Boolean(
            storedPath &&
            fs.existsSync(storedPath)
          );

        return {
          ...entry,
          privatePlaybackAvailable:
            ownerPlaybackAvailable,
          ownerPlaybackAvailable,
          ownerPlaybackMode:
            externalYouTube
              ? "EXTERNAL_YOUTUBE"
              : "AGV_HOSTED_MEDIA",
          previewTicketPath:
            externalYouTube
              ? null
              : "/api/media/review/" +
                encodeURIComponent(entry.intakeId) +
                "/preview-ticket",
        };
      })
      .sort((left, right) =>
        String(
          right.updatedAt ||
            right.publishedAt ||
            right.createdAt ||
            ""
        ).localeCompare(
          String(
            left.updatedAt ||
              left.publishedAt ||
              left.createdAt ||
              ""
          )
        )
      );

    return res.json({
      ok: true,
      visibility: "FOUNDER_OWNER_MEDIA_CONTROL",
      count: items.length,
      items,
    });
  }
);

app.post(
  "/api/media/review/:intakeId/publish",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    const previouslyApproved =
      lookup.intake?.review?.decision ===
      "APPROVED";

    const publishableStatus =
      lookup.intake.status ===
        "APPROVED_FOR_PRIVATE_PUBLISHING" ||
      lookup.intake.status ===
        "UNPUBLISHED";

    if (!previouslyApproved || !publishableStatus) {
      return res.status(409).json({
        ok: false,
        error:
          "Founder approval is required before private publishing",
        status: lookup.intake.status,
        reviewDecision:
          lookup.intake?.review?.decision || "",
      });
    }

    const storedPath =
      getControlledMediaStoredPath(lookup.intake);

    if (!storedPath || !fs.existsSync(storedPath)) {
      return res.status(404).json({
        ok: false,
        error:
          "The approved stored media file was not found",
      });
    }

    const fileStat = fs.statSync(storedPath);

    if (
      !fileStat.isFile() ||
      fileStat.size !== Number(lookup.intake.filesize)
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "The stored media file failed publication verification",
      });
    }

    const now = new Date().toISOString();

    const updatedIntake = {
      ...lookup.intake,
      status: "PUBLISHED_PRIVATE_TEST",
      visibility: "Private",
      updatedAt: now,
      publishedAt: now,
      publication: {
        mode: "OWNER_PRIVATE_TEST",
        destination: "AGV_NETWORK_ON_DEMAND_PRIVATE",
        publishedAt: now,
        publishedBy:
          getControlledMediaReviewActor(req),
        priorStatus: lookup.intake.status,
        publicAccess: false,
        permanentPublicUrl: null,
      },
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "PRIVATE MEDIA PUBLISH SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the private publication record",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,
      library:
        "AGV_NETWORK_ON_DEMAND_PRIVATE",
      publicAccess: false,
      message:
        "Media published to the private AGV Network test library",
    });
  }
);

app.post(
  "/api/media/review/:intakeId/unpublish",
  requireControlledMediaSuperadmin,
  (req, res) => {
    const lookup = findControlledMediaIntakeById(
      req.params?.intakeId
    );

    if (!lookup.ok) {
      return res.status(lookup.statusCode).json({
        ok: false,
        error: lookup.error,
      });
    }

    if (
      lookup.intake.status !==
      "PUBLISHED_PRIVATE_TEST"
    ) {
      return res.status(409).json({
        ok: false,
        error:
          "Only privately published media can be unpublished",
        status: lookup.intake.status,
      });
    }

    const now = new Date().toISOString();

    const updatedIntake = {
      ...lookup.intake,
      status: "UNPUBLISHED",
      updatedAt: now,
      unpublishedAt: now,
      publication: {
        ...(lookup.intake.publication || {}),
        active: false,
        unpublishedAt: now,
        unpublishedBy:
          getControlledMediaReviewActor(req),
        unpublishReason: cleanMediaIntakeText(
          req.body?.reason,
          1000
        ),
      },
    };

    lookup.mediaIntakes[lookup.intakeIndex] =
      updatedIntake;

    try {
      saveMediaIntakes(lookup.mediaIntakes);
    } catch (error) {
      console.error(
        "PRIVATE MEDIA UNPUBLISH SAVE FAILED:",
        error.message
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not save the unpublish decision",
      });
    }

    return res.json({
      ok: true,
      intakeId: updatedIntake.intakeId,
      status: updatedIntake.status,
      intake: updatedIntake,
      publicAccess: false,
      message:
        "Media removed from the private AGV Network test library",
    });
  }
);

app.get("/api/admin/users", requireAuth, requireSuperadmin, (req, res) => {
  return res.json({
    ok: true,
    users: users.map(safeUser),
  });
});

app.post(
  "/api/admin/users/:username/deactivate",
  requireAuth,
  requireSuperadmin,
  (req, res) => {
    const username = cleanName(req.params.username).toLowerCase();
    const user = users.find(
      (entry) => entry.username.toLowerCase() === username
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    if (user.username === DEFAULT_ADMIN_USERNAME) {
      return res.status(400).json({
        ok: false,
        error: "Cannot deactivate default admin",
      });
    }

    user.isActive = false;
    saveUsers();

    return res.json({
      ok: true,
      user: safeUser(user),
    });
  }
);

app.post(
  "/api/admin/users/:username/reactivate",
  requireAuth,
  requireSuperadmin,
  (req, res) => {
    const username = cleanName(req.params.username).toLowerCase();
    const user = users.find(
      (entry) => entry.username.toLowerCase() === username
    );

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found",
      });
    }

    user.isActive = true;
    saveUsers();

    return res.json({
      ok: true,
      user: safeUser(user),
    });
  }
);

app.get("/api/rooms", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    rooms: getVisibleRoomsForUser(req).map(normalizeOwnedRoom),
  });
});

app.post("/api/rooms", requireAuth, (req, res) => {
  const name = cleanName(req.body?.name);
  const requestedCategory = cleanName(req.body?.category) || "Custom";

  const ownerId = getRoomOwnerIdFromRequest(req);
  const ownerEmail = getRoomOwnerEmailFromRequest(req);
  const ownerName = getRoomOwnerNameFromRequest(req);
  const organization = cleanRoomText(req.body?.organization || req.body?.ownerOrganization);

  const plan = normalizeRoomPlan(req.body?.plan || req.body?.currentPlan || req.body?.createdByPlan);
  const limits = ROOM_PLAN_LIMITS[plan] || ROOM_PLAN_LIMITS.FREE;
  const superAdmin = isRoomSuperAdmin(req);

  const isPrivate = superAdmin
    ? Boolean(req.body?.isPrivate)
    : Boolean(req.body?.isPrivate) && limits.allowPrivate;

  const isLocked = Boolean(req.body?.isLocked);

  const allowTicketOnly = superAdmin
    ? Boolean(req.body?.allowTicketOnly)
    : Boolean(req.body?.allowTicketOnly) && limits.allowTicketOnly;

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Room name is required",
    });
  }

  if (!superAdmin) {
    const ownedRoomCount = getOwnedRoomCount(ownerId, ownerEmail);

    if (ownedRoomCount >= limits.maxRooms) {
      return res.status(403).json({
        ok: false,
        error: "Room limit reached for " + limits.label + " plan. Limit: " + limits.maxRooms + " room(s).",
        roomLimit: limits.maxRooms,
        ownedRoomCount,
      });
    }
  }

  let id = slugify(name) || ("room-" + Date.now());
  let attempt = 1;

  while (findRoom(id)) {
    attempt += 1;
    id = (slugify(name) || "room") + "-" + attempt;
  }

  const room = sanitizeOwnedRoom({
    id,
    name,
    category: requestedCategory,
    isPrivate,
    isLocked,
    assignedHost: ownerName,
    moderators: superAdmin ? ["Admin"] : [],
    ownerId: superAdmin ? cleanRoomText(req.body?.ownerId || "agv-super-admin") : ownerId,
    ownerEmail: superAdmin ? cleanRoomText(req.body?.ownerEmail || ownerEmail).toLowerCase() : ownerEmail,
    ownerName,
    organization,
    createdBy: superAdmin ? cleanRoomText(req.body?.createdBy || "agv-super-admin") : ownerId,
    createdByPlan: plan,
    planMode: plan,
    planLabel: limits.label,
    planHostLabel: limits.hostLabel,
    maxRooms: limits.maxRooms,
    maxViewers: limits.maxViewers,
    allowPrivate: limits.allowPrivate,
    allowTicketOnly,
    createdAt: new Date().toISOString(),
  });

  rooms.push(room);
  ensureRoomState(room.id);
  saveData();

  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeOwnedRoom(room),
    rooms: getVisibleRoomsForUser(req).map(normalizeOwnedRoom),
    roomLimit: limits.maxRooms,
    ownedRoomCount: superAdmin ? rooms.length : getOwnedRoomCount(ownerId, ownerEmail),
  });
});

app.get("/api/rooms/:roomId/state", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  return res.json({
    ok: true,
    state: ensureRoomState(room.id),
    broadcast: roomBroadcasts[room.id] || null,
  });
});

app.post("/api/rooms/:roomId/assign-host", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (req.authUser.globalRole !== "superadmin") {
    return res.status(403).json({
      ok: false,
      error: "Only Admin can assign a room host",
    });
  }

  const nextHostDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!nextHostDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Host display name is required",
    });
  }

  const targetUser = findUserByDisplayName(nextHostDisplayName);

  if (!targetUser || !targetUser.isActive) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found",
    });
  }

  room.assignedHost = targetUser.displayName;
  room.moderators = uniqueNames(room.moderators).filter(
    (name) => name !== targetUser.displayName
  );

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/add-moderator", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManageModerators(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can add moderators",
    });
  }

  const nextModeratorDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!nextModeratorDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Moderator display name is required",
    });
  }

  const targetUser = findUserByDisplayName(nextModeratorDisplayName);

  if (!targetUser || !targetUser.isActive) {
    return res.status(404).json({
      ok: false,
      error: "Target user not found",
    });
  }

  if (targetUser.displayName !== room.assignedHost) {
    room.moderators = uniqueNames([
      ...(room.moderators || []),
      targetUser.displayName,
    ]);
  }

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/remove-moderator", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManageModerators(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin or the assigned host can remove moderators",
    });
  }

  const moderatorDisplayName = cleanName(
    req.body?.displayName || req.body?.user
  );

  if (!moderatorDisplayName) {
    return res.status(400).json({
      ok: false,
      error: "Moderator display name is required",
    });
  }

  room.moderators = uniqueNames(room.moderators).filter(
    (name) => name !== moderatorDisplayName
  );

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/privacy", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Not allowed",
    });
  }

  room.isPrivate = Boolean(req.body?.isPrivate);

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/lock", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Not allowed",
    });
  }

  room.isLocked = Boolean(req.body?.isLocked);

  saveData();
  emitRooms();
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    room: normalizeRoom(room),
  });
});

app.post("/api/rooms/:roomId/messages", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  const text = cleanName(req.body?.text);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Message text is required",
    });
  }

  const state = ensureRoomState(room.id);

  state.messages.push({
    id: Date.now(),
    sender: req.authUser.displayName,
    text,
    time: timeNow(),
  });

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/bulletins/add", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin, host, or moderator can add bulletins",
    });
  }

  const text = cleanName(req.body?.text);

  if (!text) {
    return res.status(400).json({
      ok: false,
      error: "Bulletin text is required",
    });
  }

  const state = ensureRoomState(room.id);

  state.bulletins.push(text);
  state.bulletinSource = "manual";

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/bulletins/import", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canManagePrivacy(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Only Admin, host, or moderator can import bulletins",
    });
  }

  const lines = Array.isArray(req.body?.lines)
    ? req.body.lines.map((line) => cleanName(line)).filter(Boolean)
    : [];

  if (lines.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "No bulletin lines provided",
    });
  }

  const state = ensureRoomState(room.id);

  state.bulletins = lines;
  state.bulletinSource = "imported";

  saveData();
  emitRoomState(room.id);

  return res.json({
    ok: true,
    state,
  });
});

app.post("/api/rooms/:roomId/presence/join", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  if (!canEnterRoom(room, req.authUser)) {
    return res.status(403).json({
      ok: false,
      error: "Room is locked",
    });
  }

  const sessionId = cleanName(req.body?.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Session id is required",
    });
  }

  const participants = joinPresence(room.id, req.authUser, sessionId);

  emitPresence(room.id);
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    participants,
  });
});

app.post(
  "/api/rooms/:roomId/presence/heartbeat",
  requireAuth,
  (req, res) => {
    const room = findRoom(req.params.roomId);

    if (!room) {
      return res.status(404).json({
        ok: false,
        error: "Room not found",
      });
    }

    const sessionId = cleanName(req.body?.sessionId);

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        error: "Session id is required",
      });
    }

    const participants = heartbeatPresence(room.id, req.authUser, sessionId);

    emitPresence(room.id);

    return res.json({
      ok: true,
      participants,
    });
  }
);

app.post("/api/rooms/:roomId/presence/leave", requireAuth, (req, res) => {
  const room = findRoom(req.params.roomId);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: "Room not found",
    });
  }

  const sessionId = cleanName(req.body?.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Session id is required",
    });
  }

  const participants = leavePresence(room.id, sessionId);

  emitPresence(room.id);
  emitRoomSnapshot(room.id);

  return res.json({
    ok: true,
    participants,
  });
});

app.post("/api/presence/disconnect", (req, res) => {
  const sessionId = cleanName(req.body?.sessionId);

  if (sessionId) {
    disconnectPresence(sessionId);
  }

  return res.json({ ok: true });
});

io.use((socket, next) => {
  try {
    const token = cleanName(socket.handshake.auth?.token);

    if (!token) {
      return next(new Error("Authentication required"));
    }

    const payload = verifyToken(token);
    const user = users.find((entry) => entry.username === payload.username);

    if (!user || !user.isActive) {
      return next(new Error("Invalid user"));
    }

    socket.authUser = safeUser(user);
    next();
  } catch (error) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  socket.on("room:subscribe", ({ roomId, sessionId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    socket.join(`room:${room.id}`);

    if (sessionId) {
      heartbeatPresence(room.id, socket.authUser, cleanName(sessionId));
      emitPresence(room.id);
    }

    socket.emit("room:snapshot", getRoomSnapshot(room.id));

    const broadcast = roomBroadcasts[room.id];

    if (broadcast && !canControlStage(room, socket.authUser)) {
      io.to(broadcast.hostSocketId).emit("viewer:request-stage", {
        roomId: room.id,
        viewerSocketId: socket.id,
        viewerName: socket.authUser.displayName,
      });
    }
  });

  socket.on("room:unsubscribe", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    socket.leave(`room:${room.id}`);
  });

  socket.on("broadcast:start", ({ roomId, mode }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    if (!canControlStage(room, socket.authUser)) {
      socket.emit("broadcast:error", {
        roomId: room.id,
        error: "Only Admin or the assigned host can broadcast to the stage",
      });
      return;
    }

    roomBroadcasts[room.id] = {
      hostSocketId: socket.id,
      hostName: socket.authUser.displayName,
      mode: cleanName(mode) || "camera",
      startedAt: new Date().toISOString(),
    };

    socket.join(`room:${room.id}`);

    emitBroadcast(room.id);
    emitRoomSnapshot(room.id);
  });

  socket.on("broadcast:stop", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (
      broadcast?.hostSocketId === socket.id ||
      canControlStage(room, socket.authUser)
    ) {
      delete roomBroadcasts[room.id];

      emitBroadcast(room.id);
      emitRoomSnapshot(room.id);

      io.to(`room:${room.id}`).emit("webrtc:stage-ended", {
        roomId: room.id,
      });
    }
  });

  socket.on("viewer:request-stage", ({ roomId }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (!broadcast?.hostSocketId) {
      socket.emit("broadcast:update", {
        roomId: room.id,
        broadcast: null,
      });
      return;
    }

    io.to(broadcast.hostSocketId).emit("viewer:request-stage", {
      roomId: room.id,
      viewerSocketId: socket.id,
      viewerName: socket.authUser.displayName,
    });
  });

  socket.on("webrtc:offer", ({ roomId, viewerSocketId, description }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    const broadcast = roomBroadcasts[room.id];

    if (!broadcast || broadcast.hostSocketId !== socket.id) {
      return;
    }

    io.to(viewerSocketId).emit("webrtc:offer", {
      roomId: room.id,
      hostSocketId: socket.id,
      hostName: socket.authUser.displayName,
      description,
    });
  });

  socket.on("webrtc:answer", ({ roomId, hostSocketId, description }) => {
    const room = findRoom(cleanName(roomId));
    if (!room) return;

    io.to(hostSocketId).emit("webrtc:answer", {
      roomId: room.id,
      viewerSocketId: socket.id,
      viewerName: socket.authUser.displayName,
      description,
    });
  });

  socket.on("webrtc:ice-candidate", ({ roomId, targetSocketId, candidate }) => {
    const room = findRoom(cleanName(roomId));

    if (!room || !targetSocketId || !candidate) {
      return;
    }

    io.to(targetSocketId).emit("webrtc:ice-candidate", {
      roomId: room.id,
      fromSocketId: socket.id,
      candidate,
    });
  });

  socket.on("disconnect", () => {
    disconnectPresence(socket.id);
    endBroadcastForSocket(socket.id);
  });
});
/*
========================================================
TICKET AUTO-JOIN SAFE PASS (NON-DESTRUCTIVE)
========================================================
*/

const TICKETS_FILE = path.join(__dirname, "stro-cheivery-tickets.json");

function loadTickets() {
  if (!fs.existsSync(TICKETS_FILE)) {
    fs.writeFileSync(TICKETS_FILE, JSON.stringify([], null, 2), "utf8");
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
  } catch (err) {
    return [];
  }
}

function findTicket(code) {
  const tickets = loadTickets();
  return tickets.find((t) => t.code === code);
}

app.get("/api/tickets/:code", (req, res) => {
  const code = String(req.params.code || "").trim();

  if (!code) {
    return res.status(400).json({
      ok: false,
      error: "Missing ticket code",
    });
  }

  const ticket = findTicket(code);

  if (!ticket) {
    return res.status(404).json({
      ok: false,
      error: "Invalid ticket",
    });
  }

  return res.json({
    ok: true,
    ticket: {
      code: ticket.code,
      roomId: ticket.roomId || "main-hall",
      buyerName: ticket.buyerName || "Guest",
    },
  });
});
/*
========================================================
PASS PROD-UPLOAD-TIMEOUT-02 — LARGE MEDIA REQUEST WINDOW
========================================================
Allows controlled media uploads to remain open long enough
for large MP4 files to reach the AGV server.
*/

const AGV_UPLOAD_REQUEST_TIMEOUT_MS = (() => {
  const configured = Number(
    process.env.AGV_UPLOAD_REQUEST_TIMEOUT_MS || 5400000
  );

  return Number.isFinite(configured) && configured >= 300000
    ? configured
    : 5400000;
})();

const AGV_UPLOAD_HEADERS_TIMEOUT_MS = (() => {
  const configured = Number(
    process.env.AGV_UPLOAD_HEADERS_TIMEOUT_MS || 120000
  );

  return Number.isFinite(configured) && configured >= 60000
    ? configured
    : 120000;
})();

const AGV_UPLOAD_KEEP_ALIVE_TIMEOUT_MS = (() => {
  const configured = Number(
    process.env.AGV_UPLOAD_KEEP_ALIVE_TIMEOUT_MS || 75000
  );

  return Number.isFinite(configured) && configured >= 5000
    ? configured
    : 75000;
})();

server.requestTimeout = AGV_UPLOAD_REQUEST_TIMEOUT_MS;

server.headersTimeout = Math.min(
  AGV_UPLOAD_HEADERS_TIMEOUT_MS,
  AGV_UPLOAD_REQUEST_TIMEOUT_MS
);

server.keepAliveTimeout =
  AGV_UPLOAD_KEEP_ALIVE_TIMEOUT_MS;

server.setTimeout(
  AGV_UPLOAD_REQUEST_TIMEOUT_MS
);

app.get("/api/media/upload-readiness", (req, res) => {
  return res.json({
    ok: true,
    service: "AGV Controlled Media Upload",
    maximumUploadBytes: CONTROLLED_MEDIA_MAX_BYTES,
    requestTimeoutMs: AGV_UPLOAD_REQUEST_TIMEOUT_MS,
    requestTimeoutMinutes: Math.round(
      AGV_UPLOAD_REQUEST_TIMEOUT_MS / 60000
    ),
    headersTimeoutMs: AGV_UPLOAD_HEADERS_TIMEOUT_MS,
    keepAliveTimeoutMs: AGV_UPLOAD_KEEP_ALIVE_TIMEOUT_MS,
  });
});

async function prepareMediaRegistryBeforeListen() {
  if (!AGV_MEDIA_REGISTRY_SUPABASE_ENABLED) {
    return {
      mode: "file",
      loaded: false,
      recordCount: loadMediaIntakes().length,
      founderDecisionCount: 0,
    };
  }

  const adapterStatus =
    getMediaRegistryAdapterStatus();

  if (!adapterStatus.configured) {
    throw new Error(
      "Supabase media registry mode is enabled but its backend configuration is unavailable."
    );
  }

  const snapshot =
    await loadMediaRegistrySnapshot();

  if (!snapshot.found) {
    throw new Error(
      "The durable Supabase media registry snapshot was not found."
    );
  }

  const intakeIds = snapshot.records
    .map((entry) =>
      String(entry?.intakeId || "").trim()
    )
    .filter(Boolean);

  if (
    intakeIds.length !== snapshot.recordCount ||
    new Set(intakeIds).size !== snapshot.recordCount
  ) {
    throw new Error(
      "The durable Supabase media registry intake-ID verification failed."
    );
  }

  fs.writeFileSync(
    MEDIA_INTAKE_FILE,
    JSON.stringify(snapshot.records, null, 2),
    "utf8"
  );

  return {
    mode: "supabase",
    loaded: true,
    recordCount: snapshot.recordCount,
    founderDecisionCount:
      snapshot.founderDecisionCount,
  };
}

async function startAgvServer() {
  const registryStartup =
    await prepareMediaRegistryBeforeListen();

  server.listen(PORT, () => {
    const usersFileExists = fs.existsSync(USERS_FILE);

    console.log(`SERVER RUNNING ON ${PORT}`);
    console.log(`DATA FILE: ${DATA_FILE}`);
    console.log(`USERS FILE: ${USERS_FILE}`);
    console.log(
      `MEDIA REGISTRY MODE: ${registryStartup.mode.toUpperCase()}`
    );

    if (registryStartup.loaded) {
      console.log(
        `MEDIA REGISTRY RECORDS: ${registryStartup.recordCount}`
      );
      console.log(
        `FOUNDER DECISIONS: ${registryStartup.founderDecisionCount}`
      );
    }

    if (!usersFileExists) {
      console.log("DEFAULT ADMIN USERNAME:", DEFAULT_ADMIN_USERNAME);
      console.log(
        "DEFAULT ADMIN PASSWORD is loaded from AGV_ADMIN_PASSWORD or the fallback in index.js."
      );
      console.log("Change the seeded admin password before exposing this server.");
    }
  });
}

startAgvServer().catch((error) => {
  console.error(
    "AGV SERVER STARTUP FAILED:",
    error.message
  );

  process.exit(1);
});
