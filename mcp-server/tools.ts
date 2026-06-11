/**
 * MCP resource and tool registration for the MyHotels widget and its backend-backed operations.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createBookingIntent, fetchHotels, getBookingIntentStatus } from "./api-client.js";
import { requireTokenWithScope, summarizeTokenClaims } from "./auth/tool-auth.js";
import { logInfo } from "./logging.js";
import {
  deriveAuthenticatedUser,
  formatBookingIntentResponse,
  formatHotelSearchResponse,
  withAuthenticatedUser,
} from "./response-mappers.js";
import type { Config } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESOURCE_MIME_TYPE = "text/html+skybridge";
const WIDGET_RESOURCE_URI = "ui://widget/myhotels-widget.html";

/** Reads the widget HTML that will be mounted either locally or through the MCP resource. */
function readWidgetMarkup(filename: string): string {
  try {
    return readFileSync(join(__dirname, "../widget-ui", filename), "utf-8");
  } catch {
    return `<!DOCTYPE html><html><body><h1>UI not built yet. Run npm run build:ui</h1></body></html>`;
  }
}

/** Registers the widget HTML resource exposed to ChatGPT through MCP resources/read. */
export function mountWidgetResources(server: McpServer): void {
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
        const html = readWidgetMarkup("myhotels-widget.html");
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
    'registered=search_hotels,search_hotels_member_rates,prepare_booking,get_booking_status'
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
      const auth = await requireTokenWithScope(config, memberRatesScope);
      if (!auth.ok) {
        logInfo(['tool'], 'search_hotels_member_rates auth requirement not satisfied');
        return auth.response;
      }
      const { accessToken, tokenInfo, scopes } = auth;
      const authenticatedUser = deriveAuthenticatedUser(tokenInfo);

      logInfo(['auth'], `validated scope=${memberRatesScope} scopes=${scopes.join(', ')} claims=${summarizeTokenClaims(tokenInfo)}`);

      const results = await fetchHotels(config, { city, memberRates: true, subjectToken: accessToken });
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
      const auth = await requireTokenWithScope(config, bookScope);
      if (!auth.ok) {
        logInfo(['tool'], 'prepare_booking auth requirement not satisfied');
        return auth.response;
      }
      const { accessToken, tokenInfo, scopes } = auth;
      logInfo(['auth'], `validated scope=${bookScope} scopes=${scopes.join(', ')} claims=${summarizeTokenClaims(tokenInfo)}`);
      const authenticatedUser = deriveAuthenticatedUser(tokenInfo);

      if (!tokenInfo.sub) {
        return {
          content: [{
            type: "text" as const,
            text: "Couldn’t start booking approval because the signed-in user could not be identified.",
          }],
        };
      }

      const bookingIntent = await createBookingIntent(config, {
        hotelId,
        startDate,
        nights,
        subjectToken: accessToken,
      });

      return withAuthenticatedUser(
        formatBookingIntentResponse(bookingIntent, bookScope),
        authenticatedUser
      );
    }
  );

  server.registerTool(
    "get_booking_status",
    {
      description: "Get the current status of a pending booking approval.",
      inputSchema: z.object({
        transactionId: z.string().describe("The transaction identifier returned by prepare_booking"),
      }),
      _meta: {
        "openai/outputTemplate": WIDGET_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Checking booking approval...",
        "openai/toolInvocation/invoked": "Booking status updated",
        "openai/widgetAccessible": true,
        "openai/visibility": "public",
        securitySchemes: [
          { type: "oauth2", scopes: [bookScope] },
        ],
      },
    },
    async ({ transactionId }: { transactionId: string }) => {
      logInfo(['tool'], `get_booking_status called transactionId=${transactionId}`);
      const auth = await requireTokenWithScope(config, bookScope);
      if (!auth.ok) {
        logInfo(['tool'], 'get_booking_status auth requirement not satisfied');
        return auth.response;
      }
      logInfo(['auth'], `validated scope=${bookScope} scopes=${auth.scopes.join(', ')} claims=${summarizeTokenClaims(auth.tokenInfo)}`);
      const authenticatedUser = deriveAuthenticatedUser(auth.tokenInfo);

      if (!auth.tokenInfo.sub) {
        return {
          content: [{
            type: "text" as const,
            text: "Couldn’t check booking status because the signed-in user could not be identified.",
          }],
        };
      }

      try {
        const bookingIntent = await getBookingIntentStatus(config, {
          transactionId,
          subjectToken: auth.accessToken,
        });
        return withAuthenticatedUser(
          formatBookingIntentResponse(bookingIntent, bookScope),
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
