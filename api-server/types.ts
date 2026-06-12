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

export interface BookingIntent extends BookingQuote {
  transactionId: string;
  ownerSub: string;
  status: "pending" | "confirmed";
  createdAt: string;
  updatedAt: string;
  backendBookingId?: string;
  confirmedAt?: string;
}

export interface BookingIntentResponse {
  bookingIntent: {
    transactionId: string;
    hotelId: string;
    hotelName: string;
    startDate: string;
    nights: number;
    nightlyRate: number;
    totalPrice: number;
    currency: string;
    status: string;
    updatedAt: string;
    backendBookingId?: string;
    confirmedAt?: string;
  };
}
