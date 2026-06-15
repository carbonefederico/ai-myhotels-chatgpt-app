/**
 * Shared JWT validation utilities used by both the MCP transport and the backend API.
 */
import { createPublicKey, verify as verifySignature } from "crypto";

export interface ValidatedTokenClaims {
  active: boolean;
  scope?: string;
  client_id?: string;
  sub?: string;
  username?: string;
  given_name?: string;
  groups?: string[];
  act?: Record<string, unknown>;
  token_type?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string[];
  azp?: string;
}

export interface JwtValidationConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
}

export interface JwtValidationLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

type JsonWebKey = {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  x5c?: string[];
};

type CachedJwks = {
  keysById: Map<string, JsonWebKey>;
  expiresAt: number;
};

type CachedToken = {
  claims: ValidatedTokenClaims;
  expiresAt: number;
};

const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const TOKEN_CACHE_TTL_MS = 60 * 1000;

const jwksCache = new Map<string, CachedJwks>();
const tokenCache = new Map<string, CachedToken>();

/** Redacts a token before writing it to debug logs. */
function redactToken(token: string): string {
  if (token.length <= 16) {
    return token;
  }

  return `${token.slice(0, 10)}...${token.slice(-8)}`;
}

/** Produces a compact claim summary for auth debugging. */
export function summarizeValidatedClaims(claims: ValidatedTokenClaims): string {
  return JSON.stringify({
    active: claims.active,
    scope: claims.scope,
    client_id: claims.client_id,
    sub: claims.sub,
    username: claims.username,
    given_name: claims.given_name,
    groups: claims.groups,
    act: claims.act,
    iss: claims.iss,
    aud: claims.aud,
    azp: claims.azp,
    exp: claims.exp,
    iat: claims.iat,
  });
}

/** Pretty-prints JSON for multi-line logs. */
function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Decodes JWT claims without verifying the token, for debug logging only. */
export function decodeJwtClaimsForLogging(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    return JSON.parse(decodeBase64Url(parts[1]).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Decodes a base64url-encoded JWT segment. */
function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}

/** Parses a JWT into header, payload, signature, and signed content. */
function parseJwt(token: string): {
  signingInput: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Token is not a JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = JSON.parse(decodeBase64Url(encodedHeader).toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8")) as Record<string, unknown>;
  const signature = decodeBase64Url(encodedSignature);

  return {
    signingInput: `${encodedHeader}.${encodedPayload}`,
    header,
    payload,
    signature,
  };
}

/** Normalizes a string-or-array claim into a string array. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    return [value];
  }

  return [];
}

/** Maps the raw JWT payload into the normalized claim shape used in this repo. */
function normalizeClaims(payload: Record<string, unknown>): ValidatedTokenClaims {
  return {
    active: true,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    client_id: typeof payload.client_id === "string" ? payload.client_id : undefined,
    sub: typeof payload.sub === "string" ? payload.sub : undefined,
    username: typeof payload.username === "string" ? payload.username : undefined,
    given_name: typeof payload.given_name === "string" ? payload.given_name : undefined,
    groups: Array.isArray(payload.groups) || typeof payload.groups === "string" ? toStringArray(payload.groups) : undefined,
    act: payload.act && typeof payload.act === "object" && !Array.isArray(payload.act) ? (payload.act as Record<string, unknown>) : undefined,
    token_type: typeof payload.token_type === "string" ? payload.token_type : undefined,
    exp: typeof payload.exp === "number" ? payload.exp : undefined,
    iat: typeof payload.iat === "number" ? payload.iat : undefined,
    iss: typeof payload.iss === "string" ? payload.iss : undefined,
    aud: Array.isArray(payload.aud) || typeof payload.aud === "string" ? toStringArray(payload.aud) : undefined,
    azp: typeof payload.azp === "string" ? payload.azp : undefined,
  };
}

/** Fetches or reuses the configured JWKS document for signature validation. */
async function fetchJwks(config: JwtValidationConfig, logger: JwtValidationLogger): Promise<Map<string, JsonWebKey>> {
  const cached = jwksCache.get(config.jwksUrl);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    logger.info(`jwks cache hit url=${config.jwksUrl}`);
    return cached.keysById;
  }

  logger.info(`jwks fetch url=${config.jwksUrl}`);
  const response = await fetch(config.jwksUrl);
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { keys?: JsonWebKey[] };
  const keysById = new Map<string, JsonWebKey>();
  for (const key of body.keys || []) {
    if (key.kid) {
      keysById.set(key.kid, key);
    }
  }

  jwksCache.set(config.jwksUrl, {
    keysById,
    expiresAt: now + JWKS_CACHE_TTL_MS,
  });

  return keysById;
}

/** Verifies the JWT signature against the matching JWK and declared algorithm. */
function verifyJwtSignature(
  signingInput: string,
  signature: Buffer,
  jwk: JsonWebKey,
  alg: unknown
): boolean {
  if (typeof alg !== "string" || !alg.startsWith("RS")) {
    throw new Error(`Unsupported JWT signing algorithm: ${String(alg)}`);
  }

  const algorithmMap: Record<string, string> = {
    RS256: "RSA-SHA256",
    RS384: "RSA-SHA384",
    RS512: "RSA-SHA512",
  };

  const verifyAlgorithm = algorithmMap[alg];
  if (!verifyAlgorithm) {
    throw new Error(`Unsupported JWT signing algorithm: ${alg}`);
  }

  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  return verifySignature(verifyAlgorithm, Buffer.from(signingInput, "utf8"), publicKey, signature);
}

/** Enforces issuer, expiry, issued-at, and audience constraints. */
function validateClaims(claims: ValidatedTokenClaims, config: JwtValidationConfig): void {
  const now = Math.floor(Date.now() / 1000);

  if (!claims.iss || claims.iss !== config.issuer) {
    throw new Error(`JWT issuer mismatch: expected="${config.issuer}" received="${claims.iss ?? "<missing>"}"`);
  }

  if (!claims.exp || claims.exp <= now) {
    throw new Error("JWT has expired");
  }

  if (claims.iat && claims.iat > now + 60) {
    throw new Error("JWT issued-at timestamp is in the future");
  }

  const audiences = claims.aud || [];
  const matchedAudience = audiences.includes(config.audience) || claims.azp === config.audience;
  if (!matchedAudience) {
    throw new Error(
      `JWT audience mismatch: expected="${config.audience}" received.aud=${JSON.stringify(audiences)} received.azp="${claims.azp ?? "<missing>"}"`
    );
  }
}

/** Validates a bearer token locally and returns normalized claims for downstream auth checks. */
export async function validateJwtToken(
  token: string,
  config: JwtValidationConfig,
  logger: JwtValidationLogger
): Promise<ValidatedTokenClaims> {
  const now = Date.now();
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    logger.info(`token cache hit token=${redactToken(token)} claims=\n${prettyJson(cached.claims)}`);
    return cached.claims;
  }

  try {
    logger.info(`validating jwt token=${redactToken(token)}`);
    const parsed = parseJwt(token);
    logger.info(`jwt header kid=${String(parsed.header.kid ?? "")} alg=${String(parsed.header.alg ?? "")}`);
    logger.info(`jwt payload=\n${prettyJson(parsed.payload)}`);
    const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : undefined;
    if (!kid) {
      throw new Error("JWT header does not include kid");
    }

    const jwks = await fetchJwks(config, logger);
    const jwk = jwks.get(kid);
    if (!jwk) {
      throw new Error("No matching JWK found for token");
    }

    const signatureValid = verifyJwtSignature(parsed.signingInput, parsed.signature, jwk, parsed.header.alg);
    if (!signatureValid) {
      throw new Error("JWT signature verification failed");
    }

    const claims = normalizeClaims(parsed.payload);
    validateClaims(claims, config);
    logger.info(`jwt validated claims=\n${prettyJson(claims)}`);

    const expMs = claims.exp ? claims.exp * 1000 : now + TOKEN_CACHE_TTL_MS;
    tokenCache.set(token, {
      claims,
      expiresAt: Math.min(now + TOKEN_CACHE_TTL_MS, expMs),
    });

    return claims;
  } catch (error) {
    logger.error("jwt validation failed", error);
    return { active: false };
  }
}
