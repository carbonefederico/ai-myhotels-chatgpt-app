/**
 * Backend REST service for hotel search, booking-intent creation, and CIBA-backed approval polling.
 */
import "dotenv/config";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { hotels, searchHotels } from "./data/hotels.js";
import {
  decodeJwtClaimsForLogging,
  summarizeValidatedClaims,
  validateJwtToken,
  type JwtValidationConfig,
  type ValidatedTokenClaims,
} from "../shared/jwt-validation.js";
import type {
  BookingIntent,
  BookingIntentResponse,
  CreateBookingIntentRequest,
  QuoteBookingRequest,
} from "./types.js";

interface ApiServerConfig {
  port: number;
  authServerUrl: string;
  authIssuer: string;
  authJwksUrl: string;
  apiAudience: string;
  apiScope: string;
  cibaAuthorizationEndpoint: string;
  cibaTokenEndpoint: string;
  cibaClientId: string;
  cibaClientSecret: string;
  cibaScope: string;
  cibaAcrValues?: string;
  cibaRequestedExpiry?: number;
}

interface CibaAuthorizationResponse {
  auth_req_id: string;
  expires_in: number;
  interval?: number;
}

interface CibaPendingResponse {
  error: "authorization_pending" | "slow_down";
  error_description?: string;
}

interface CibaTerminalErrorResponse {
  error:
    | "access_denied"
    | "expired_token"
    | "invalid_grant"
    | "invalid_request"
    | "invalid_client"
    | "unauthorized_client";
  error_description?: string;
}

interface CibaApprovedResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

type CibaTokenPollResponse =
  | { kind: "approved"; tokens: CibaApprovedResponse }
  | { kind: "pending"; error: CibaPendingResponse["error"]; errorDescription?: string }
  | { kind: "denied"; errorDescription?: string }
  | { kind: "expired"; errorDescription?: string };

const bookingIntents = new Map<string, BookingIntent>();

/** Builds the REST payload returned by the hotel search endpoint. */
function buildHotelSearchPayload(includeMemberRates: boolean, city?: string) {
  const results = searchHotels(city);
  return {
    hotels: results.map((hotel) => ({
      id: hotel.id,
      name: hotel.name,
      imageUrl: hotel.imageUrl,
      location: hotel.location,
      city: hotel.city,
      country: hotel.country,
      latitude: hotel.latitude,
      longitude: hotel.longitude,
      rating: hotel.rating,
      standardRate: hotel.standardRate,
      amenities: hotel.amenities,
      ...(includeMemberRates && hotel.memberRate
        ? {
            memberRate: hotel.memberRate,
            savings: hotel.standardRate - hotel.memberRate,
          }
        : {}),
    })),
  };
}

/** Calculates the quoted booking terms for a requested hotel booking. */
function calculateBookingQuote(input: QuoteBookingRequest) {
  const hotel = hotels.find((item) => item.id === input.hotelId);

  if (!hotel) {
    return null;
  }

  const nightlyRate = hotel.memberRate ?? hotel.standardRate;
  const totalPrice = nightlyRate * input.nights;

  return {
    hotelId: hotel.id,
    hotelName: hotel.name,
    startDate: input.startDate,
    nights: input.nights,
    nightlyRate,
    totalPrice,
    currency: "EUR",
  };
}

/** Loads runtime configuration for the backend API service. */
function loadConfig(): ApiServerConfig {
  const apiPort = process.env.API_PORT;
  const authServerUrl = process.env.AUTH_SERVER_URL;
  const apiAudience = process.env.API_AUDIENCE;
  const apiScope = process.env.API_SCOPE;
  const cibaClientId = process.env.CIBA_CLIENT_ID;
  const cibaClientSecret = process.env.CIBA_CLIENT_SECRET;
  const cibaScope = process.env.CIBA_SCOPE;

  if (!apiPort) {
    throw new Error("API_PORT environment variable is required");
  }

  if (!authServerUrl) {
    throw new Error("AUTH_SERVER_URL environment variable is required");
  }

  if (!apiAudience) {
    throw new Error("API_AUDIENCE environment variable is required");
  }

  if (!apiScope) {
    throw new Error("API_SCOPE environment variable is required");
  }

  if (!cibaScope) {
    throw new Error("CIBA_SCOPE environment variable is required");
  }

  const port = parseInt(apiPort, 10);
  const authIssuer = authServerUrl;
  const authJwksUrl = `${authIssuer}/jwks`;
  const cibaAuthorizationEndpoint = `${authServerUrl}/cibaAuthorization`;
  const cibaTokenEndpoint = `${authServerUrl}/token`;
  const cibaAcrValues = undefined;
  const cibaRequestedExpiry = undefined;

  if (Number.isNaN(port)) {
    throw new Error("API_PORT environment variable must be a valid integer");
  }

  if (!cibaClientId) {
    throw new Error("CIBA_CLIENT_ID environment variable is required");
  }

  if (!cibaClientSecret) {
    throw new Error("CIBA_CLIENT_SECRET environment variable is required");
  }

  return {
    port,
    authServerUrl,
    authIssuer,
    authJwksUrl,
    apiAudience,
    apiScope,
    cibaAuthorizationEndpoint,
    cibaTokenEndpoint,
    cibaClientId,
    cibaClientSecret,
    cibaScope,
    cibaAcrValues,
    cibaRequestedExpiry,
  };
}

/** Produces a timestamped backend log line with consistent bracketed scopes. */
function logApi(scope: string, message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  if (error === undefined) {
    console.log(`${timestamp} [api][${scope}] ${message}`);
    return;
  }

  console.error(`${timestamp} [api][${scope}] ${message}`, error);
}

function prettyJsonForLog(value: unknown, maxLength = 4000): string {
  const pretty = JSON.stringify(value, null, 2);
  return pretty.length > maxLength ? `${pretty.slice(0, maxLength)}\n...<truncated>` : pretty;
}

/** Produces a compact request summary for backend transport logs. */
function summarizeRequest(req: Request): string {
  const hasBearer = Boolean(req.headers.authorization?.startsWith("Bearer "));
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? ` bodyKeys=${Object.keys(req.body).join(",")}`
      : "";
  const queryKeys = Object.keys(req.query ?? {});
  const query = queryKeys.length > 0 ? ` queryKeys=${queryKeys.join(",")}` : "";
  return `method=${req.method} path=${req.path} hasBearer=${hasBearer}${query}${body}`;
}

/** Produces a compact response preview for backend transport logs. */
function summarizeResponseBody(bodyText: string): string {
  if (!bodyText) {
    return "body=<empty>";
  }

  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    return `bodyKeys=${keys.join(",")} payload=\n${prettyJsonForLog(parsed)}`;
  } catch {
    const preview = bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}\n...<truncated>` : bodyText;
    return `body=\n${preview}`;
  }
}

/** Captures request and response details for backend REST debugging. */
function attachApiTransportLogging(app: express.Application): void {
  app.use((req, res, next) => {
    logApi("request", summarizeRequest(req));

    const chunks: Buffer[] = [];
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const toBuffer = (chunk: any, encoding?: unknown): Buffer => {
      if (Buffer.isBuffer(chunk)) {
        return chunk;
      }
      if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk);
      }
      if (ArrayBuffer.isView(chunk)) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      if (chunk instanceof ArrayBuffer) {
        return Buffer.from(chunk);
      }
      const bufferEncoding = typeof encoding === "string" ? (encoding as BufferEncoding) : undefined;
      return Buffer.from(String(chunk), bufferEncoding);
    };

    res.write = ((chunk: any, encoding?: any, callback?: any) => {
      if (chunk) {
        chunks.push(toBuffer(chunk, encoding));
      }
      return originalWrite(chunk, encoding, callback);
    }) as typeof res.write;

    res.end = ((chunk?: any, encoding?: any, callback?: any) => {
      if (chunk) {
        chunks.push(toBuffer(chunk, encoding));
      }
      return originalEnd(chunk, encoding, callback);
    }) as typeof res.end;

    res.on("finish", () => {
      const contentType = String(res.getHeader("content-type") ?? "");
      const bodyText = Buffer.concat(chunks).toString("utf8");
      logApi(
        "response",
        `status=${res.statusCode} contentType=${contentType} ${summarizeResponseBody(bodyText)}`
      );
    });

    next();
  });
}

/** Creates the Basic authorization header value used for PingOne CIBA calls. */
function buildBasicAuth(config: ApiServerConfig): string {
  return Buffer.from(`${config.cibaClientId}:${config.cibaClientSecret}`).toString("base64");
}

/** Generates the short approval code shown to the user during the CIBA flow. */
function createApprovalBindingMessage(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Starts a new backchannel approval request for a booking intent. */
async function requestApprovalSession(
  config: ApiServerConfig,
  input: {
    loginHint: string;
    bindingMessage: string;
    scope?: string;
    customParameters?: Record<string, string>;
  }
): Promise<CibaAuthorizationResponse> {
  const params = new URLSearchParams({
    scope: input.scope || config.cibaScope,
    login_hint: input.loginHint,
    binding_message: input.bindingMessage,
  });

  if (input.customParameters) {
    for (const [key, value] of Object.entries(input.customParameters)) {
      params.set(key, value);
    }
  }

  if (config.cibaAcrValues) {
    params.set("acr_values", config.cibaAcrValues);
  }

  if (config.cibaRequestedExpiry !== undefined) {
    params.set("requested_expiry", String(config.cibaRequestedExpiry));
  }

  const response = await fetch(config.cibaAuthorizationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${buildBasicAuth(config)}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `CIBA authorization request failed: ${response.status} ${response.statusText} ${errorBody}`
    );
  }

  const payload = (await response.json()) as CibaAuthorizationResponse;
  logApi(
    "ciba",
    `authorization created authReqId=${payload.auth_req_id} expiresIn=${payload.expires_in} interval=${payload.interval ?? ""}`
  );
  return payload;
}

/** Splits the space-delimited OAuth scope claim into a normalized array. */
function getScopes(tokenInfo: ValidatedTokenClaims): string[] {
  return tokenInfo.scope ? tokenInfo.scope.split(" ") : [];
}

/** Extracts a bearer token from the Authorization header. */
function readBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7);
}

/** Writes a consistent protected-endpoint error response. */
function sendAuthError(res: Response, status: number, error: string): null {
  res.status(status).json({ error });
  return null;
}

/** Validates the bearer token for backend API endpoints that require member access. */
async function requireApiToken(
  req: Request,
  res: Response,
  config: ApiServerConfig
): Promise<{ tokenInfo: ValidatedTokenClaims; scopes: string[] } | null> {
  const token = readBearerToken(req);
  if (!token) {
    return sendAuthError(res, 401, "Sign in required for this action.");
  }

  const validationConfig: JwtValidationConfig = {
    issuer: config.authIssuer,
    jwksUrl: config.authJwksUrl,
    audience: config.apiAudience,
  };

  const tokenInfo = await validateJwtToken(token, validationConfig, {
    info(message) {
      logApi("auth", message);
    },
    error(message, error) {
      logApi("auth", message, error);
    },
  });

  if (!tokenInfo.active) {
    return sendAuthError(res, 401, "Token is invalid or expired.");
  }

  const scopes = getScopes(tokenInfo);
  if (!scopes.includes(config.apiScope)) {
    logApi("auth", `insufficient scope required=${config.apiScope} actual=${scopes.join(",")} claims=${summarizeValidatedClaims(tokenInfo)}`);
    return sendAuthError(res, 403, `This action requires ${config.apiScope}.`);
  }

  logApi("auth", `validated scope=${config.apiScope} scopes=${scopes.join(",")} claims=${summarizeValidatedClaims(tokenInfo)}`);
  return { tokenInfo, scopes };
}

/** Polls the token endpoint for the current state of a backchannel approval request. */
async function pollApprovalSession(
  config: ApiServerConfig,
  authRequestId: string
): Promise<CibaTokenPollResponse> {
  const params = new URLSearchParams({
    grant_type: "urn:openid:params:grant-type:ciba",
    auth_req_id: authRequestId,
  });

  const response = await fetch(config.cibaTokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${buildBasicAuth(config)}`,
    },
    body: params.toString(),
  });

  if (response.ok) {
    const tokens = (await response.json()) as CibaApprovedResponse;
    const accessTokenClaims = decodeJwtClaimsForLogging(tokens.access_token);
    if (accessTokenClaims) {
      logApi("ciba", `approved accessTokenClaims=${JSON.stringify(accessTokenClaims)}`);
    } else {
      logApi("ciba", "approved access token is not a readable JWT");
    }

    const idTokenClaims = tokens.id_token ? decodeJwtClaimsForLogging(tokens.id_token) : null;
    if (idTokenClaims) {
      logApi("ciba", `approved idTokenClaims=${JSON.stringify(idTokenClaims)}`);
    } else if (tokens.id_token) {
      logApi("ciba", "approved id token is not a readable JWT");
    }

    return { kind: "approved", tokens };
  }

  const errorBody = (await response.json()) as CibaPendingResponse | CibaTerminalErrorResponse;

  switch (errorBody.error) {
    case "authorization_pending":
    case "slow_down":
      return {
        kind: "pending",
        error: errorBody.error,
        errorDescription: errorBody.error_description,
      };
    case "access_denied":
      return { kind: "denied", errorDescription: errorBody.error_description };
    case "expired_token":
    case "invalid_grant":
      return { kind: "expired", errorDescription: errorBody.error_description };
    default:
      throw new Error(
        `CIBA token polling failed: ${response.status} ${response.statusText} ${errorBody.error}`
      );
  }
}

/** Serializes internal booking-intent state into the public API response shape. */
function serializeBookingIntent(bookingIntent: BookingIntent): BookingIntentResponse {
  return {
    bookingIntent: {
      transactionId: bookingIntent.transactionId,
      hotelId: bookingIntent.hotelId,
      hotelName: bookingIntent.hotelName,
      bindingMessage: bookingIntent.bindingMessage,
      startDate: bookingIntent.startDate,
      nights: bookingIntent.nights,
      nightlyRate: bookingIntent.nightlyRate,
      totalPrice: bookingIntent.totalPrice,
      currency: bookingIntent.currency,
      status: bookingIntent.status,
      updatedAt: bookingIntent.updatedAt,
      pollIntervalSeconds: bookingIntent.pollIntervalSeconds,
      approvalCompletedAt: bookingIntent.approvalCompletedAt,
      approvedScopes: bookingIntent.approvedScopes,
      hasRefreshToken: bookingIntent.hasRefreshToken,
    },
  };
}

/** Creates the Express application for the backend REST API. */
export function assembleApiApp(config: ApiServerConfig): express.Application {
  const app = express();
  app.use(express.json());
  attachApiTransportLogging(app);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/hotels", async (req, res) => {
    const city = typeof req.query.city === "string" ? req.query.city : undefined;
    const memberRates = req.query.memberRates === "true";
    if (memberRates) {
      const auth = await requireApiToken(req, res, config);
      if (!auth) {
        return;
      }
      res.json(buildHotelSearchPayload(true, city));
      return;
    }
    res.json(buildHotelSearchPayload(false, city));
  });

  app.post("/booking-intents", async (req, res) => {
    const auth = await requireApiToken(req, res, config);
    if (!auth) {
      return;
    }

    const body = req.body as CreateBookingIntentRequest;
    const ownerSub = auth.tokenInfo.sub;
    if (!ownerSub) {
      res.status(400).json({ error: "Signed-in user could not be identified." });
      return;
    }

    const quote = calculateBookingQuote(body);
    if (!quote) {
      res.status(404).json({ error: "Hotel not found" });
      return;
    }

    const transactionId = randomUUID();
    const bindingMessage = createApprovalBindingMessage();
    const cibaResponse = await requestApprovalSession(config, {
      loginHint: ownerSub,
      bindingMessage,
      customParameters: {
        transaction_id: transactionId,
        hotel_id: quote.hotelId,
        hotel_name: quote.hotelName,
        check_in_date: body.startDate,
        nights: String(body.nights),
        amount: quote.totalPrice.toFixed(2),
        currency: quote.currency,
      },
    });

    const now = Date.now();
    const bookingIntent: BookingIntent = {
      transactionId,
      ownerSub,
      authRequestId: cibaResponse.auth_req_id,
      bindingMessage,
      hotelId: quote.hotelId,
      hotelName: quote.hotelName,
      startDate: quote.startDate,
      nights: quote.nights,
      nightlyRate: quote.nightlyRate,
      totalPrice: quote.totalPrice,
      currency: quote.currency,
      status: "pending_user_approval",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      pollIntervalSeconds: cibaResponse.interval ?? 2,
      nextPollAt: now + (cibaResponse.interval ?? 2) * 1000,
      expiresAt: now + cibaResponse.expires_in * 1000,
    };

    bookingIntents.set(transactionId, bookingIntent);
    res.json(serializeBookingIntent(bookingIntent));
  });

  app.get("/booking-intents/:transactionId", async (req, res) => {
    const auth = await requireApiToken(req, res, config);
    if (!auth) {
      return;
    }

    const transactionId = req.params.transactionId;
    const ownerSub = auth.tokenInfo.sub;

    if (!ownerSub) {
      res.status(400).json({ error: "Signed-in user could not be identified." });
      return;
    }

    const bookingIntent = bookingIntents.get(transactionId);
    if (!bookingIntent || bookingIntent.ownerSub !== ownerSub) {
      res.status(404).json({ error: "Booking intent not found" });
      return;
    }

    if (bookingIntent.status !== "pending_user_approval") {
      res.json(serializeBookingIntent(bookingIntent));
      return;
    }

    const now = Date.now();
    if (now >= bookingIntent.expiresAt) {
      const expiredBookingIntent: BookingIntent = {
        ...bookingIntent,
        status: "expired",
        updatedAt: new Date(now).toISOString(),
      };
      bookingIntents.set(transactionId, expiredBookingIntent);
      res.json(serializeBookingIntent(expiredBookingIntent));
      return;
    }

    if (now < bookingIntent.nextPollAt) {
      res.json(serializeBookingIntent(bookingIntent));
      return;
    }

    const cibaStatus = await pollApprovalSession(config, bookingIntent.authRequestId);

    if (cibaStatus.kind === "approved") {
      const approvalCompletedAt = new Date(now).toISOString();

      const approvedBookingIntent: BookingIntent = {
        ...bookingIntent,
        status: "approved",
        updatedAt: new Date(now).toISOString(),
        approvalCompletedAt,
        approvedScopes: cibaStatus.tokens.scope,
        tokenExpiresIn: cibaStatus.tokens.expires_in,
        hasRefreshToken: Boolean(cibaStatus.tokens.refresh_token),
        backendBookingId: randomUUID(),
      };
      bookingIntents.set(transactionId, approvedBookingIntent);
      res.json(serializeBookingIntent(approvedBookingIntent));
      return;
    }

    if (cibaStatus.kind === "denied") {
      const deniedBookingIntent: BookingIntent = {
        ...bookingIntent,
        status: "denied",
        updatedAt: new Date(now).toISOString(),
      };
      bookingIntents.set(transactionId, deniedBookingIntent);
      res.json(serializeBookingIntent(deniedBookingIntent));
      return;
    }

    if (cibaStatus.kind === "expired") {
      const expiredBookingIntent: BookingIntent = {
        ...bookingIntent,
        status: "expired",
        updatedAt: new Date(now).toISOString(),
      };
      bookingIntents.set(transactionId, expiredBookingIntent);
      res.json(serializeBookingIntent(expiredBookingIntent));
      return;
    }

    const nextIntervalSeconds =
      cibaStatus.error === "slow_down"
        ? bookingIntent.pollIntervalSeconds + 5
        : bookingIntent.pollIntervalSeconds;

    const pendingBookingIntent: BookingIntent = {
      ...bookingIntent,
      pollIntervalSeconds: nextIntervalSeconds,
      nextPollAt: now + nextIntervalSeconds * 1000,
      updatedAt: new Date(now).toISOString(),
    };
    bookingIntents.set(transactionId, pendingBookingIntent);
    res.json(serializeBookingIntent(pendingBookingIntent));
  });

  return app;
}

/** Starts the backend REST server on the configured port. */
export function launchApiServer(): void {
  const config = loadConfig();
  const app = assembleApiApp(config);
  app.listen(config.port, () => {
    logApi("server", `listening on port ${config.port}`);
  });
}

launchApiServer();
