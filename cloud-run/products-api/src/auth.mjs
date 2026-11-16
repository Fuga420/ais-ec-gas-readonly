import crypto from "node:crypto";
import { asTrimmedString } from "./productMapper.mjs";

const STAFF_TOKEN_CACHE_TTL_MS = 60_000;
const STAFF_TOKEN_CACHE_MAX_ENTRIES = 200;

function safeConstantTimeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function decodeJwtExpMs(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const authHeader = asTrimmedString(req.headers?.authorization || "");
  if (!authHeader) return "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Creates a staff/internal request verifier.
 * - Accepts server-side `X-Internal-Sync-Token` matching `PRODUCTS_API_INTERNAL_SECRET`
 *   (used only by Cloud Scheduler / backend scripts; never embedded in browsers).
 * - Otherwise requires a valid Supabase Auth user session JWT (`Authorization: Bearer <access_token>`)
 *   whose user has `app_metadata.role === "staff"` / `app_metadata.staff === true`
 *   OR an active entry in `public.staff_users`.
 * - Rejects missing tokens, `anon` / `publishable` keys, expired tokens (`401`),
 *   and non-staff accounts (`403`).
 */
export function createAuthVerifier({
  getInternalSecret = () =>
    asTrimmedString(process.env.PRODUCTS_API_INTERNAL_SECRET),
} = {}) {
  const verifiedTokenCache = new Map();

  return async function verifyStaffOrInternalRequest(req, supabase) {
    const configuredInternalSecret = getInternalSecret();
    const providedInternalToken = asTrimmedString(
      req.headers?.["x-internal-sync-token"] || ""
    );

    if (providedInternalToken) {
      if (
        configuredInternalSecret &&
        safeConstantTimeEquals(providedInternalToken, configuredInternalSecret)
      ) {
        return { ok: true, actorType: "internal", email: "internal-sync" };
      }
      return {
        ok: false,
        status: 401,
        errorCode: "INVALID_INTERNAL_TOKEN",
        error: "Invalid internal sync token",
      };
    }

    const bearerToken = extractBearerToken(req);
    if (!bearerToken) {
      return {
        ok: false,
        status: 401,
        errorCode: "UNAUTHORIZED",
        error: "Authentication required",
      };
    }

    // Fast reject if someone tries passing a publishable key directly
    if (bearerToken.startsWith("sb_publishable_") || bearerToken.startsWith("sb_secret_")) {
      return {
        ok: false,
        status: 401,
        errorCode: "INVALID_TOKEN",
        error: "User session token required",
      };
    }

    const nowMs = Date.now();
    const tokenKey = hashToken(bearerToken);
    const cached = verifiedTokenCache.get(tokenKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return { ok: true, actorType: "staff", email: cached.email, userId: cached.userId };
    }
    if (cached) {
      verifiedTokenCache.delete(tokenKey);
    }

    if (!supabase?.auth || typeof supabase.auth.getUser !== "function") {
      return {
        ok: false,
        status: 500,
        errorCode: "AUTH_BACKEND_UNAVAILABLE",
        error: "Auth verification service unavailable",
      };
    }

    const { data, error } = await supabase.auth.getUser(bearerToken);
    if (error || !data?.user || !data.user.id) {
      return {
        ok: false,
        status: 401,
        errorCode: "INVALID_TOKEN",
        error: "Invalid or expired session token",
      };
    }

    const user = data.user;
    const email = asTrimmedString(user.email).toLowerCase();
    const appMeta =
      user.app_metadata && typeof user.app_metadata === "object"
        ? user.app_metadata
        : {};

    let isAuthorizedStaff =
      appMeta.role === "staff" || appMeta.staff === true;

    if (!isAuthorizedStaff && email) {
      const { data: staffRow, error: staffErr } = await supabase
        .from("staff_users")
        .select("email,is_active")
        .eq("email", email)
        .eq("is_active", true)
        .maybeSingle();

      if (staffErr) {
        throw new Error(`Failed checking staff_users: ${staffErr.message}`);
      }
      isAuthorizedStaff = Boolean(staffRow && staffRow.is_active === true);
    }

    if (!isAuthorizedStaff) {
      return {
        ok: false,
        status: 403,
        errorCode: "FORBIDDEN_NOT_STAFF",
        error: "This account is not authorized for B.I.S admin access",
      };
    }

    const jwtExpMs = decodeJwtExpMs(bearerToken);
    const expiresAtMs = jwtExpMs
      ? Math.min(nowMs + STAFF_TOKEN_CACHE_TTL_MS, jwtExpMs)
      : nowMs + STAFF_TOKEN_CACHE_TTL_MS;

    if (expiresAtMs > nowMs) {
      if (verifiedTokenCache.size >= STAFF_TOKEN_CACHE_MAX_ENTRIES) {
        const oldestKey = verifiedTokenCache.keys().next().value;
        if (oldestKey) verifiedTokenCache.delete(oldestKey);
      }
      verifiedTokenCache.set(tokenKey, {
        userId: user.id,
        email,
        expiresAtMs,
      });
    }

    return { ok: true, actorType: "staff", email, userId: user.id };
  };
}

const WRITE_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const WRITE_TOKEN_CACHE_MAX_ENTRIES = 200;

/**
 * Creates a write-access verifier for Cloud Run draft product write APIs.
 * - Prevents third parties knowing only the Cloud Run URL from operating write endpoints.
 * - Requires NO individual staff accounts or login screen, and embeds NO fixed secret key in browser code.
 * - Reuses existing mechanisms:
 *   1. Server-to-server `X-Internal-Sync-Token` (`PRODUCTS_API_INTERNAL_SECRET` in Secret Manager), OR
 *   2. Active Readdy Backend client credential (`Authorization: Bearer <token>` / `apikey`, auto-injected by
 *      Readdy Backend via `src/lib/supabaseClient.ts` as used by `documents-relay` & `gas-ai-batch-relay`),
 *      verified server-side against `${READDY_BACKEND_URL}/auth/v1/settings` with short-lived SHA-256 cache,
 *      plus optional `ALLOWED_ORIGINS` check when `Origin` header is present, OR
 *   3. Valid Product Master Supabase staff session JWT (if ever used).
 * - Fails closed (`401`/`403`/`503`) whenever credentials are missing, invalid, or unverifiable.
 */
export function createWriteAccessVerifier({
  getInternalSecret = () =>
    asTrimmedString(process.env.PRODUCTS_API_INTERNAL_SECRET),
  getReaddyBackendUrl = () =>
    asTrimmedString(process.env.READDY_BACKEND_URL),
  getAllowedOrigins = () =>
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  fetchImpl = globalThis.fetch,
} = {}) {
  const verifiedWriteCache = new Map();
  const verifyStaff = createAuthVerifier({ getInternalSecret });

  return async function verifyWriteRequest(req, supabase) {
    // 1. Server-to-server internal secret header
    const configuredInternalSecret = getInternalSecret();
    const providedInternalToken = asTrimmedString(
      req.headers?.["x-internal-sync-token"] || ""
    );
    if (providedInternalToken) {
      if (
        configuredInternalSecret &&
        safeConstantTimeEquals(providedInternalToken, configuredInternalSecret)
      ) {
        return { ok: true, actorType: "internal" };
      }
      return {
        ok: false,
        status: 401,
        errorCode: "INVALID_INTERNAL_TOKEN",
        error: "Invalid internal sync token",
      };
    }

    // 2. Origin allowlist enforcement when configured and browser Origin header is present
    const allowedOrigins = getAllowedOrigins();
    const requestOrigin = asTrimmedString(req.headers?.origin || "");
    if (
      allowedOrigins.length > 0 &&
      requestOrigin &&
      !allowedOrigins.includes(requestOrigin)
    ) {
      return {
        ok: false,
        status: 403,
        errorCode: "FORBIDDEN_ORIGIN",
        error: "Origin is not authorized for write operations",
      };
    }

    // 3. Extract caller credential (Authorization Bearer or apikey)
    const bearerToken = extractBearerToken(req);
    const apiKeyHeader = asTrimmedString(req.headers?.apikey || "");
    const candidateToken = bearerToken || apiKeyHeader;

    if (!candidateToken) {
      return {
        ok: false,
        status: 401,
        errorCode: "UNAUTHORIZED",
        error: "Write authorization required",
      };
    }

    if (candidateToken.startsWith("sb_secret_")) {
      return {
        ok: false,
        status: 401,
        errorCode: "INVALID_TOKEN",
        error: "Secret keys must not be sent as client write credentials",
      };
    }

    const readdyUrl = getReaddyBackendUrl().replace(/\/+$/, "");
    const effectiveApiKey = apiKeyHeader || candidateToken;
    const nowMs = Date.now();
    const cacheKey = hashToken(`${readdyUrl}|${candidateToken}|${effectiveApiKey}`);
    const cached = verifiedWriteCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return { ok: true, actorType: cached.actorType };
    }
    if (cached) {
      verifiedWriteCache.delete(cacheKey);
    }

    // 4. Verify against existing Readdy Backend project (/auth/v1/settings)
    if (readdyUrl) {
      let verifyRes;
      try {
        verifyRes = await fetchImpl(`${readdyUrl}/auth/v1/settings`, {
          method: "GET",
          headers: {
            apikey: effectiveApiKey,
            Authorization: `Bearer ${candidateToken}`,
          },
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return {
          ok: false,
          status: 503,
          errorCode: "AUTH_BACKEND_UNAVAILABLE",
          error: "Write authorization verification failed",
        };
      }

      if (verifyRes && verifyRes.ok) {
        if (verifiedWriteCache.size >= WRITE_TOKEN_CACHE_MAX_ENTRIES) {
          const oldestKey = verifiedWriteCache.keys().next().value;
          if (oldestKey) verifiedWriteCache.delete(oldestKey);
        }
        verifiedWriteCache.set(cacheKey, {
          actorType: "readdy-backend",
          expiresAtMs: nowMs + WRITE_TOKEN_CACHE_TTL_MS,
        });
        return { ok: true, actorType: "readdy-backend" };
      }

      if (verifyRes && verifyRes.status >= 500) {
        return {
          ok: false,
          status: 503,
          errorCode: "AUTH_BACKEND_UNAVAILABLE",
          error: "Write authorization backend returned server error",
        };
      }
    }

    // 5. Optional fallback: Product Master Supabase staff session JWT
    if (!candidateToken.startsWith("sb_publishable_") && supabase?.auth) {
      const staffCheck = await verifyStaff(req, supabase);
      if (staffCheck.ok) {
        return staffCheck;
      }
    }

    return {
      ok: false,
      status: 401,
      errorCode: "UNAUTHORIZED",
      error: "Invalid or unauthorized write credential",
    };
  };
}
