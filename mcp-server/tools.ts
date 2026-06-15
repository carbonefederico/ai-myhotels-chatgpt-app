/**
 * MCP resource and tool registration for the MyHotels widget and its backend-backed operations.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { confirmBookingIntent, createBookingIntent, fetchHotels, quoteBooking } from "./api-client.js";
import {
  getBookingApprovalStatus,
  markBookingApprovalConfirmed,
  startBookingApproval,
} from "./booking-approvals.js";
import {
  AuthorizeDeniedError,
  readInboundBearerToken,
  requireAuthorizeDecision,
  requiresHumanInTheLoop,
  type AuthorizeDecisionResponse,
} from "./authorize-pdp.js";
import { logInfo } from "./logging.js";
import {
  deriveAuthenticatedUser,
  formatBookingIntentResponse,
  formatHotelSearchResponse,
  withAuthenticatedUser,
} from "./response-mappers.js";
import { decodeJwtClaimsForLogging } from "../shared/jwt-validation.js";
import type { Config } from "./server.js";
import type { BackendBookingIntent, BookingApproval, TokenClaims } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESOURCE_MIME_TYPE = "text/html+skybridge";
const WIDGET_RESOURCE_URI = "ui://widget/myhotels-widget.html";

function readPolicyDeniedMessage(error: AuthorizeDeniedError): string | undefined {
  for (const statement of error.statements) {
    if (typeof statement.payload === "string" && statement.payload.trim()) {
      return statement.payload.trim();
    }
  }

  return undefined;
}

function buildPolicyDeniedResponse(resource: string, error: AuthorizeDeniedError) {
  const deniedMessage = readPolicyDeniedMessage(error);

  return {
    content: [{
      type: "text" as const,
      text: deniedMessage ?? `This ${resource} request was denied by policy.`,
    }],
    _meta: {
      myHotelsPolicyDecision: {
        resource: error.resource,
        decision: error.decision,
        status: error.statusCode,
        correlationId: error.correlationId,
        statements: error.statements,
      },
    },
  };
}

async function requirePolicyOrResponse(
  config: Config,
  input: {
    resource: string;
    parameters?: Record<string, unknown>;
  }
): Promise<
  | { ok: true; decision: AuthorizeDecisionResponse }
  | { ok: false; response: ReturnType<typeof buildPolicyDeniedResponse> }
> {
  try {
    const decision = await requireAuthorizeDecision(config, input);
    return { ok: true, decision };
  } catch (error) {
    if (error instanceof AuthorizeDeniedError) {
      return { ok: false, response: buildPolicyDeniedResponse(input.resource, error) };
    }
    throw error;
  }
}

function buildTokenRequiredResponse(action: string) {
  return {
    content: [{
      type: "text" as const,
      text: `This ${action} request requires a signed-in user token.`,
    }],
  };
}

function normalizeParsedClaims(claims: Record<string, unknown> | null): TokenClaims {
  const aud = claims?.aud;
  const groups = claims?.groups;
  const act = claims?.act;
  return {
    active: true,
    scope: typeof claims?.scope === "string" ? claims.scope : undefined,
    client_id: typeof claims?.client_id === "string" ? claims.client_id : undefined,
    sub: typeof claims?.sub === "string" ? claims.sub : undefined,
    username: typeof claims?.username === "string" ? claims.username : undefined,
    given_name: typeof claims?.given_name === "string" ? claims.given_name : undefined,
    groups: Array.isArray(groups)
      ? groups.filter((item): item is string => typeof item === "string")
      : typeof groups === "string"
        ? [groups]
        : undefined,
    act: act && typeof act === "object" && !Array.isArray(act) ? (act as Record<string, unknown>) : undefined,
    token_type: typeof claims?.token_type === "string" ? claims.token_type : undefined,
    exp: typeof claims?.exp === "number" ? claims.exp : undefined,
    iat: typeof claims?.iat === "number" ? claims.iat : undefined,
    iss: typeof claims?.iss === "string" ? claims.iss : undefined,
    aud: Array.isArray(aud)
      ? aud.filter((item): item is string => typeof item === "string")
      : typeof aud === "string"
        ? [aud]
        : undefined,
    azp: typeof claims?.azp === "string" ? claims.azp : undefined,
  };
}

function readPermittedInboundToken(action: string): { accessToken: string; tokenInfo: TokenClaims } | { response: ReturnType<typeof buildTokenRequiredResponse> } {
  const accessToken = readInboundBearerToken();
  if (!accessToken) {
    return { response: buildTokenRequiredResponse(action) };
  }

  return {
    accessToken,
    tokenInfo: normalizeParsedClaims(decodeJwtClaimsForLogging(accessToken)),
  };
}

function toConfirmedBookingApproval(bookingIntent: BackendBookingIntent): BookingApproval {
  return {
    transactionId: bookingIntent.transactionId,
    bindingMessage: "",
    hotelId: bookingIntent.hotelId,
    hotelName: bookingIntent.hotelName,
    startDate: bookingIntent.startDate,
    nights: bookingIntent.nights,
    nightlyRate: bookingIntent.nightlyRate,
    totalPrice: bookingIntent.totalPrice,
    currency: bookingIntent.currency,
    status: "approved",
    updatedAt: bookingIntent.updatedAt,
    pollIntervalSeconds: 0,
    approvalCompletedAt: bookingIntent.confirmedAt,
    backendBookingId: bookingIntent.backendBookingId,
    confirmedAt: bookingIntent.confirmedAt,
  };
}

function resolvePublicAssetUrl(config: Config, assetPath: string): string {
  const baseUrl = (config.publicUrl || `http://localhost:${config.port}`).replace(/\/$/, "");
  const normalizedPath = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  return `${baseUrl}${normalizedPath}`;
}

/** Reads the widget HTML that will be mounted either locally or through the MCP resource. */
function readWidgetMarkup(filename: string, config: Config): string {
  try {
    return readFileSync(join(__dirname, "../widget-ui", filename), "utf-8")
      .replace(/__MYHOTELS_LOGO_URL__/g, resolvePublicAssetUrl(config, "/widget-assets/myhotels-logo.png"));
  } catch {
    return `<!DOCTYPE html><html><body><h1>UI not built yet. Run npm run build:ui</h1></body></html>`;
  }
}

/** Registers the widget HTML resource exposed to ChatGPT through MCP resources/read. */
export function mountWidgetResources(server: McpServer, config: Config): void {
  const resourceOptions = {
    description: "Interactive MyHotels search and booking interface",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      prefersBorder: false,
    },
  };

  const registerWidgetResource = (name: string, uri: string): void => {
    server.registerResource(
      name,
      uri,
      resourceOptions,
      async () => {
        logInfo(['resource'], `${uri} read`);
        const html = readWidgetMarkup("myhotels-widget.html", config);
        return {
          contents: [
            {
              uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: html,
              _meta: {
                prefersBorder: false,
              },
            },
          ],
        };
      }
    );
  };

  registerWidgetResource("MyHotels Widget", WIDGET_RESOURCE_URI);
  logInfo(['mcp', 'resources'], `registered=${WIDGET_RESOURCE_URI}`);
}

/** Registers the public and protected MCP tools used by the widget and ChatGPT runtime. */
export function mountMcpTools(server: McpServer, config: Config): void {
  const memberRatesScope = config.mcpMemberRatesScope;
  const bookScope = config.mcpBookScope;

  logInfo(
    ['mcp', 'tools'],
    'registered=search_hotels,search_hotels_member_rates,prepare_booking,finalize_booking'
  );

  server.registerTool(
    "search_hotels",
    {
      description: "Search available hotels with public rates. No authentication required.",
      inputSchema: z.object({
        city: z.string().optional().describe("City name to search for hotels (e.g., 'Paris', 'London')"),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Searching for hotels...",
        "openai/toolInvocation/invoked": "Hotels found",
        "openai/widgetAccessible": true,
        "openai/visibility": "public",
        securitySchemes: [
          { type: "noauth" },
        ],
      },
    },
    async ({ city }: { city?: string }) => {
      logInfo(['tool'], `search_hotels called city=${city ?? ''}`);
      const policyDenied = await requirePolicyOrResponse(config, {
        resource: "search_hotels",
        parameters: { city },
      });
      if (!policyDenied.ok) {
        return policyDenied.response;
      }
      const results = await fetchHotels(config, { city, memberRates: false });
      return formatHotelSearchResponse(results, false, config, city);
    }
  );

  server.registerTool(
    "search_hotels_member_rates",
    {
      description: `Search hotels with member pricing. Requires a token with ${memberRatesScope}.`,
      inputSchema: z.object({
        city: z.string().optional().describe("City name to search for hotels"),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Fetching member rates...",
        "openai/toolInvocation/invoked": "Member rates loaded",
        "openai/widgetAccessible": true,
        "openai/visibility": "public",
        securitySchemes: [
          { type: "oauth2", scopes: [memberRatesScope] },
        ],
      },
    },
    async ({ city }: { city?: string }) => {
      logInfo(['tool'], `search_hotels_member_rates called city=${city ?? ''}`);
      const policyDenied = await requirePolicyOrResponse(config, {
        resource: "search_hotels_member_rates",
        parameters: { city },
      });
      if (!policyDenied.ok) {
        return policyDenied.response;
      }
      const auth = readPermittedInboundToken("member rates");
      if ("response" in auth) {
        return auth.response;
      }
      const authenticatedUser = deriveAuthenticatedUser(auth.tokenInfo);
      const results = await fetchHotels(config, { city, memberRates: true, subjectToken: auth.accessToken });
      return withAuthenticatedUser(
        formatHotelSearchResponse(results, true, config, city),
        authenticatedUser
      );
    }
  );

  server.registerTool(
    "prepare_booking",
    {
      description: "Create a booking intent and start server-side approval.",
      inputSchema: z.object({
        hotelId: z.string().describe("The hotel identifier to book"),
        startDate: z.string().describe("The check-in date in YYYY-MM-DD format"),
        nights: z.number().int().min(1).max(30).describe("Number of nights to book"),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Starting booking approval...",
        "openai/toolInvocation/invoked": "Booking approval started",
        "openai/widgetAccessible": true,
        "openai/visibility": "public",
        securitySchemes: [
          { type: "oauth2", scopes: [bookScope] },
        ],
      },
    },
    async ({ hotelId, startDate, nights }: { hotelId: string; startDate: string; nights: number }) => {
      logInfo(['tool'], `prepare_booking called hotelId=${hotelId} startDate=${startDate} nights=${nights}`);
      const auth = readPermittedInboundToken("booking");
      if ("response" in auth) {
        return auth.response;
      }
      const authenticatedUser = deriveAuthenticatedUser(auth.tokenInfo);

      if (!auth.tokenInfo.sub) {
        return {
          content: [{
            type: "text" as const,
            text: "Couldn’t start booking approval because the signed-in user could not be identified.",
          }],
        };
      }

      const quote = await quoteBooking(config, {
        hotelId,
        startDate,
        nights,
        subjectToken: auth.accessToken,
      });

      const policyDecision = await requirePolicyOrResponse(config, {
        resource: "prepare_booking",
        parameters: {
          hotelId: quote.hotelId,
          hotelName: quote.hotelName,
          startDate: quote.startDate,
          nights: quote.nights,
          nightlyRate: quote.nightlyRate,
          totalPrice: quote.totalPrice,
          currency: quote.currency,
        },
      });
      if (!policyDecision.ok) {
        return policyDecision.response;
      }

      const bookingIntent = await createBookingIntent(config, {
        hotelId,
        startDate,
        nights,
        subjectToken: auth.accessToken,
      });

      if (!requiresHumanInTheLoop(policyDecision.decision)) {
        const confirmedBookingIntent = await confirmBookingIntent(config, {
          transactionId: bookingIntent.transactionId,
          subjectToken: auth.accessToken,
        });
        return withAuthenticatedUser(
          formatBookingIntentResponse(toConfirmedBookingApproval(confirmedBookingIntent), bookScope),
          authenticatedUser
        );
      }

      const bookingApproval = await startBookingApproval(config, {
        bookingIntent,
        ownerSub: auth.tokenInfo.sub,
      });

      return withAuthenticatedUser(
        formatBookingIntentResponse(bookingApproval, bookScope),
        authenticatedUser
      );
    }
  );

  server.registerTool(
    "finalize_booking",
    {
      description: "Attempt to finalize a pending booking after user approval, returning pending status while approval is incomplete.",
      inputSchema: z.object({
        transactionId: z.string().describe("The transaction identifier returned by prepare_booking"),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Finalizing booking...",
        "openai/toolInvocation/invoked": "Booking finalization checked",
        "openai/widgetAccessible": true,
        "openai/visibility": "public",
        securitySchemes: [
          { type: "oauth2", scopes: [bookScope] },
        ],
      },
    },
    async ({ transactionId }: { transactionId: string }) => {
      logInfo(['tool'], `finalize_booking called transactionId=${transactionId}`);
      const policyDenied = await requirePolicyOrResponse(config, {
        resource: "finalize_booking",
        parameters: { transactionId },
      });
      if (!policyDenied.ok) {
        return policyDenied.response;
      }
      const auth = readPermittedInboundToken("booking finalization");
      if ("response" in auth) {
        return auth.response;
      }
      const authenticatedUser = deriveAuthenticatedUser(auth.tokenInfo);

      if (!auth.tokenInfo.sub) {
        return {
          content: [{
            type: "text" as const,
            text: "Couldn’t finalize booking because the signed-in user could not be identified.",
          }],
        };
      }

      try {
        const bookingApproval = await getBookingApprovalStatus(config, {
          transactionId,
          ownerSub: auth.tokenInfo.sub,
        });

        if (!bookingApproval) {
          return {
            content: [{
              type: "text" as const,
              text: "Booking request not found or no longer available.",
            }],
          };
        }

        if (bookingApproval.status === "approved" && !bookingApproval.backendBookingId) {
          const confirmedBookingIntent = await confirmBookingIntent(config, {
            transactionId,
            subjectToken: auth.accessToken,
          });
          const confirmedApproval = markBookingApprovalConfirmed(confirmedBookingIntent) ?? bookingApproval;
          return withAuthenticatedUser(
            formatBookingIntentResponse(confirmedApproval, bookScope),
            authenticatedUser
          );
        }

        return withAuthenticatedUser(
          formatBookingIntentResponse(bookingApproval, bookScope),
          authenticatedUser
        );
      } catch (error) {
        if (error instanceof Error && /404\b/.test(error.message)) {
          return {
            content: [{
              type: "text" as const,
              text: "Booking request not found or no longer available.",
            }],
          };
        }
        throw error;
      }
    }
  );
}
