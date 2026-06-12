/**
 * Response mappers that normalize backend data and auth context into MCP widget payloads.
 */
import { requestStorage } from "./server.js";
import type { Config } from "./server.js";
import type { AuthenticatedUser, BookingApproval, Hotel, TokenClaims } from "./types.js";

/** Resolves relative asset paths against the active request host or configured public URL. */
function resolveAssetUrl(config: Config, assetPath?: string): string | undefined {
  if (!assetPath) {
    return undefined;
  }

  if (/^https?:\/\//.test(assetPath) || assetPath.startsWith("data:")) {
    return assetPath;
  }

  const req = requestStorage.getStore();
  const forwardedProto = req?.headers["x-forwarded-proto"];
  const protocolHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = protocolHeader || req?.protocol;
  const host = req?.get("host");
  const requestBaseUrl = protocol && host ? `${protocol}://${host}` : undefined;
  const baseUrl = (requestBaseUrl || config.publicUrl || `http://localhost:${config.port}`).replace(/\/$/, "");
  const normalizedPath = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  return `${baseUrl}${normalizedPath}`;
}

/** Formats hotel search results into the widget response shape consumed by the frontend. */
export function formatHotelSearchResponse(hotels: Hotel[], includeMemberRates: boolean, config: Config, city?: string) {
  if (hotels.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: `No hotels found${city ? ` in ${city}` : ""}.${!includeMemberRates ? " Try searching for Paris, London, Milan, Rome, Berlin, or Florence." : ""}`,
      }],
      structuredContent: {
        hotels: [],
        ...((!includeMemberRates && !city) && { availableCities: ["Paris", "London", "Milan", "Rome", "Berlin", "Florence"] }),
      },
    };
  }

  const textSummary = hotels.map((hotel) => {
    const rate = includeMemberRates && hotel.memberRate
      ? `Member Rate: €${hotel.memberRate}/night (Save €${hotel.standardRate - hotel.memberRate})`
      : `Standard Rate: €${hotel.standardRate}/night`;
    return `${hotel.name} - ${hotel.city}, ${hotel.country} | ${hotel.rating}⭐ | ${rate}`;
  }).join("\n");

  const prefix = includeMemberRates ? "with member pricing" : "";

  return {
    content: [{
      type: "text" as const,
      text: `Found ${hotels.length} hotel(s) ${prefix}:\n\n${textSummary}`,
    }],
    structuredContent: {
      hotels: hotels.map((hotel) => ({
        id: hotel.id,
        name: hotel.name,
        imageUrl: resolveAssetUrl(config, hotel.imageUrl),
        location: hotel.location,
        city: hotel.city,
        country: hotel.country,
        latitude: hotel.latitude,
        longitude: hotel.longitude,
        rating: hotel.rating,
        standardRate: hotel.standardRate,
        amenities: hotel.amenities,
        ...(includeMemberRates && hotel.memberRate && {
          memberRate: hotel.memberRate,
          savings: hotel.standardRate - hotel.memberRate,
        }),
      })),
      ...(includeMemberRates && { authenticated: true }),
    },
  };
}

/** Chooses the best display identity from JWT claims for the widget masthead. */
export function deriveAuthenticatedUser(tokenInfo: TokenClaims): AuthenticatedUser {
  const firstName = tokenInfo.given_name?.trim() || undefined;
  const username = tokenInfo.username?.trim() || undefined;
  const sub = tokenInfo.sub?.trim() || undefined;

  return {
    firstName,
    username,
    sub,
    displayName: firstName || username || sub || "Member",
  };
}

/** Attaches normalized authenticated-user data to an existing structured widget response. */
export function withAuthenticatedUser<T extends { structuredContent?: Record<string, unknown> }>(
  response: T,
  authenticatedUser: AuthenticatedUser
): T {
  return {
    ...response,
    structuredContent: {
      ...(response.structuredContent || {}),
      authenticatedUser,
    },
  };
}

/** Formats booking-intent status into the widget response shape used by the approval card. */
export function formatBookingIntentResponse(booking: BookingApproval | null | undefined, requiredScope: string) {
  if (!booking) {
    return {
      content: [{
        type: "text" as const,
        text: "Booking request not found or no longer available.",
      }],
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `Booking for ${booking.hotelName} is currently ${booking.status.replace(/_/g, " ")}.`,
    }],
    structuredContent: {
      bookingApproval: {
        transactionId: booking.transactionId,
        hotelId: booking.hotelId,
        hotelName: booking.hotelName,
        bindingMessage: booking.bindingMessage,
        startDate: booking.startDate,
        nights: booking.nights,
        nightlyRate: booking.nightlyRate,
        totalPrice: booking.totalPrice,
        currency: booking.currency,
        requiredScope: booking.requiredScope || requiredScope,
        status: booking.status,
        updatedAt: booking.updatedAt,
        pollIntervalSeconds: booking.pollIntervalSeconds,
        approvalCompletedAt: booking.approvalCompletedAt,
        approvedScopes: booking.approvedScopes,
        hasRefreshToken: booking.hasRefreshToken,
        backendBookingId: booking.backendBookingId,
        confirmedAt: booking.confirmedAt,
      },
    },
  };
}
