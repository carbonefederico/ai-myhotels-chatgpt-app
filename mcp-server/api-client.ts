/**
 * Thin REST client used by the MCP layer to forward hotel and booking-intent calls to the backend API.
 */
import { logInfo } from "./logging.js";
import type { Config } from "./server.js";
import type { BackendBookingIntent, BackendBookingQuote, Hotel } from "./types.js";

interface HotelSearchResponse {
  hotels: Hotel[];
}

interface BookingIntentResponse {
  bookingIntent: BackendBookingIntent;
}

interface BookingQuoteResponse {
  quote: BackendBookingQuote;
}

interface TokenExchangeResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

type CachedBackendToken = {
  accessToken: string;
  expiresAt: number;
};

const backendTokenCache = new Map<string, CachedBackendToken>();

/** Parses backend JSON or throws a transport-level error with the response body. */
async function handleJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/** Builds the client-credential header used by the MCP server for token exchange. */
function buildClientBasicAuth(config: Config): string {
  return Buffer.from(`${config.mcpClientId}:${config.mcpClientSecret}`).toString("base64");
}

/** Exchanges the ChatGPT-facing access token for a backend API access token. */
async function exchangeBackendAccessToken(config: Config, subjectToken: string, apiScope: string): Promise<string> {
  const cacheKey = `${subjectToken}:${config.apiAudience}:${apiScope}`;
  const now = Date.now();
  const cached = backendTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    logInfo(
      ["mcp", "token-exchange"],
      `cache hit audience=${config.apiAudience} scope=${apiScope}`
    );
    return cached.accessToken;
  }

  logInfo(
    ["mcp", "token-exchange"],
    `requesting audience=${config.apiAudience} scope=${apiScope}`
  );

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience: config.apiAudience,
    scope: apiScope,
  });

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${buildClientBasicAuth(config)}`,
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  const payload = (await response.json()) as TokenExchangeResponse;
  if (!payload.access_token) {
    throw new Error("Token exchange did not return an access token");
  }

  logInfo(
    ["mcp", "token-exchange"],
    `received backend token tokenType=${payload.token_type ?? ""} expiresIn=${payload.expires_in ?? ""}`
  );

  const expiresAt = now + Math.max((payload.expires_in ?? 60) - 5, 5) * 1000;
  backendTokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt,
  });

  return payload.access_token;
}

/** Builds an Authorization header for backend calls that require an exchanged API token. */
async function buildBackendAuthHeaders(
  config: Config,
  subjectToken: string,
  apiScope: string
): Promise<Record<string, string>> {
  const backendAccessToken = await exchangeBackendAccessToken(config, subjectToken, apiScope);
  return {
    Authorization: `Bearer ${backendAccessToken}`,
  };
}

/** Loads public or member hotel results from the backend API. */
export async function fetchHotels(
  config: Config,
  options: { city?: string; memberRates: boolean; subjectToken?: string }
): Promise<Hotel[]> {
  const url = new URL("/hotels", config.apiBaseUrl);
  if (options.city) {
    url.searchParams.set("city", options.city);
  }
  url.searchParams.set("memberRates", String(options.memberRates));

  const headers =
    options.memberRates && options.subjectToken
      ? await buildBackendAuthHeaders(config, options.subjectToken, config.apiMemberRatesScope)
      : undefined;

  const payload = await handleJsonResponse<HotelSearchResponse>(await fetch(url, { headers }));
  return payload.hotels;
}

/** Requests an authoritative backend quote before policy evaluation creates booking state. */
export async function quoteBooking(
  config: Config,
  input: {
    hotelId: string;
    startDate: string;
    nights: number;
    subjectToken: string;
  }
): Promise<BackendBookingQuote> {
  const headers = await buildBackendAuthHeaders(config, input.subjectToken, config.apiBookScope);
  const response = await fetch(new URL("/booking-quotes", config.apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      hotelId: input.hotelId,
      startDate: input.startDate,
      nights: input.nights,
    }),
  });

  const payload = await handleJsonResponse<BookingQuoteResponse>(response);
  return payload.quote;
}

/** Creates a new booking intent through the backend booking-intents resource. */
export async function createBookingIntent(
  config: Config,
  input: {
    hotelId: string;
    startDate: string;
    nights: number;
    subjectToken: string;
  }
): Promise<BackendBookingIntent> {
  const headers = await buildBackendAuthHeaders(config, input.subjectToken, config.apiBookScope);
  const response = await fetch(new URL("/booking-intents", config.apiBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      hotelId: input.hotelId,
      startDate: input.startDate,
      nights: input.nights,
    }),
  });

  const payload = await handleJsonResponse<BookingIntentResponse>(response);
  return payload.bookingIntent;
}

/** Confirms a backend booking intent after MCP-owned CIBA approval completes. */
export async function confirmBookingIntent(
  config: Config,
  input: {
    transactionId: string;
    subjectToken: string;
  }
): Promise<BackendBookingIntent> {
  const url = new URL(`/booking-intents/${input.transactionId}/confirm`, config.apiBaseUrl);
  const headers = await buildBackendAuthHeaders(config, input.subjectToken, config.apiBookScope);

  const payload = await handleJsonResponse<BookingIntentResponse>(await fetch(url, {
    method: "POST",
    headers,
  }));
  return payload.bookingIntent;
}
