/** MCP-side types for validated token claims, widget payloads, and exposed scopes. */
import type { ValidatedTokenClaims } from "../shared/jwt-validation.js";

export type TokenClaims = ValidatedTokenClaims;

export interface BookingApproval {
  transactionId: string;
  hotelId: string;
  hotelName: string;
  bindingMessage: string;
  startDate: string;
  nights: number;
  nightlyRate: number;
  totalPrice: number;
  currency: string;
  requiredScope?: string;
  status: string;
  updatedAt: string;
  pollIntervalSeconds: number;
  approvalCompletedAt?: string;
  approvedScopes?: string;
  hasRefreshToken?: boolean;
}

export interface AuthenticatedUser {
  firstName?: string;
  username?: string;
  sub?: string;
  displayName: string;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
}

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
