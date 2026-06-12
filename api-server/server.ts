/**
 * Backend REST service for hotel search, booking-intent creation, and booking confirmation.
 */
import "dotenv/config";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { hotels, searchHotels } from "./data/hotels.js";
import {
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
  apiMemberRatesScope: string;
  apiBookScope: string;
}

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
  const apiMemberRatesScope = process.env.API_MEMBER_RATES_SCOPE;
  const apiBookScope = process.env.API_BOOK_SCOPE;

  if (!apiPort) {
    throw new Error("API_PORT environment variable is required");
  }

  if (!authServerUrl) {
    throw new Error("AUTH_SERVER_URL environment variable is required");
  }

  if (!apiAudience) {
    throw new Error("API_AUDIENCE environment variable is required");
  }

  if (!apiMemberRatesScope) {
    throw new Error("API_MEMBER_RATES_SCOPE environment variable is required");
  }

  if (!apiBookScope) {
    throw new Error("API_BOOK_SCOPE environment variable is required");
  }

  const port = parseInt(apiPort, 10);
  const authIssuer = authServerUrl;
  const authJwksUrl = `${authIssuer}/jwks`;

  if (Number.isNaN(port)) {
    throw new Error("API_PORT environment variable must be a valid integer");
  }

  return {
    port,
    authServerUrl,
    authIssuer,
    authJwksUrl,
    apiAudience,
    apiMemberRatesScope,
    apiBookScope,
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

/** Validates the bearer token for backend API endpoints that require a specific scope. */
async function requireApiToken(
  req: Request,
  res: Response,
  config: ApiServerConfig,
  requiredScope: string
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
  if (!scopes.includes(requiredScope)) {
    logApi("auth", `insufficient scope required=${requiredScope} actual=${scopes.join(",")} claims=${summarizeValidatedClaims(tokenInfo)}`);
    return sendAuthError(res, 403, `This action requires ${requiredScope}.`);
  }

  logApi("auth", `validated scope=${requiredScope} scopes=${scopes.join(",")} claims=${summarizeValidatedClaims(tokenInfo)}`);
  return { tokenInfo, scopes };
}

/** Serializes internal booking-intent state into the public API response shape. */
function serializeBookingIntent(bookingIntent: BookingIntent): BookingIntentResponse {
  return {
    bookingIntent: {
      transactionId: bookingIntent.transactionId,
      hotelId: bookingIntent.hotelId,
      hotelName: bookingIntent.hotelName,
      startDate: bookingIntent.startDate,
      nights: bookingIntent.nights,
      nightlyRate: bookingIntent.nightlyRate,
      totalPrice: bookingIntent.totalPrice,
      currency: bookingIntent.currency,
      status: bookingIntent.status,
      updatedAt: bookingIntent.updatedAt,
      backendBookingId: bookingIntent.backendBookingId,
      confirmedAt: bookingIntent.confirmedAt,
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
      const auth = await requireApiToken(req, res, config, config.apiMemberRatesScope);
      if (!auth) {
        return;
      }
      res.json(buildHotelSearchPayload(true, city));
      return;
    }
    res.json(buildHotelSearchPayload(false, city));
  });

  app.post("/booking-intents", async (req, res) => {
    const auth = await requireApiToken(req, res, config, config.apiBookScope);
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
    const now = Date.now();
    const bookingIntent: BookingIntent = {
      transactionId,
      ownerSub,
      hotelId: quote.hotelId,
      hotelName: quote.hotelName,
      startDate: quote.startDate,
      nights: quote.nights,
      nightlyRate: quote.nightlyRate,
      totalPrice: quote.totalPrice,
      currency: quote.currency,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    bookingIntents.set(transactionId, bookingIntent);
    res.json(serializeBookingIntent(bookingIntent));
  });

  app.get("/booking-intents/:transactionId", async (req, res) => {
    const auth = await requireApiToken(req, res, config, config.apiBookScope);
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

    res.json(serializeBookingIntent(bookingIntent));
  });

  app.post("/booking-intents/:transactionId/confirm", async (req, res) => {
    const auth = await requireApiToken(req, res, config, config.apiBookScope);
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

    if (bookingIntent.status === "confirmed") {
      res.json(serializeBookingIntent(bookingIntent));
      return;
    }

    const now = new Date().toISOString();
    const confirmedBookingIntent: BookingIntent = {
      ...bookingIntent,
      status: "confirmed",
      updatedAt: now,
      confirmedAt: now,
      backendBookingId: randomUUID(),
    };

    bookingIntents.set(transactionId, confirmedBookingIntent);
    res.json(serializeBookingIntent(confirmedBookingIntent));
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
