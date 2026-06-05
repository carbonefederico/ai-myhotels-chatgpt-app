/** Shared backend REST contract types for hotels, booking intents, and approval responses. */
export interface Hotel {
  id: string;
  name: string;
  imageUrl?: string;
  location: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  rating: number;
  standardRate: number;
  memberRate?: number;
  amenities: string[];
}

export interface BookingQuote {
  hotelId: string;
  hotelName: string;
  startDate: string;
  nights: number;
  nightlyRate: number;
  totalPrice: number;
  currency: string;
}

export interface QuoteBookingRequest {
  hotelId: string;
  startDate: string;
  nights: number;
}

export type CreateBookingIntentRequest = QuoteBookingRequest;

export interface ConfirmedBooking extends BookingQuote {
  bookingId: string;
  ownerSub: string;
  status: "confirmed";
  confirmedAt: string;
}

export interface ApiErrorResponse {
  error: string;
}

export interface BookingIntent {
  transactionId: string;
  ownerSub: string;
  authRequestId: string;
  bindingMessage: string;
  hotelId: string;
  hotelName: string;
  startDate: string;
  nights: number;
  nightlyRate: number;
  totalPrice: number;
  currency: string;
  status: "pending_user_approval" | "approved" | "denied" | "expired";
  createdAt: string;
  updatedAt: string;
  pollIntervalSeconds: number;
  nextPollAt: number;
  expiresAt: number;
  approvalCompletedAt?: string;
  approvedScopes?: string;
  tokenExpiresIn?: number;
  hasRefreshToken?: boolean;
  backendBookingId?: string;
}

export interface BookingIntentResponse {
  bookingIntent: {
    transactionId: string;
    hotelId: string;
    hotelName: string;
    bindingMessage: string;
    startDate: string;
    nights: number;
    nightlyRate: number;
    totalPrice: number;
    currency: string;
    status: string;
    updatedAt: string;
    pollIntervalSeconds: number;
    approvalCompletedAt?: string;
    approvedScopes?: string;
    hasRefreshToken?: boolean;
  };
}
