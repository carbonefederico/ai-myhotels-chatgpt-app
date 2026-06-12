/**
 * MCP-owned CIBA approval orchestration for agent-initiated booking actions.
 */
import { randomUUID } from "crypto";
import { decodeJwtClaimsForLogging } from "../shared/jwt-validation.js";
import { logInfo } from "./logging.js";
import type { Config } from "./server.js";
import type { BackendBookingIntent, BookingApproval } from "./types.js";

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

interface BookingApprovalState extends BookingApproval {
  ownerSub: string;
  authRequestId: string;
  nextPollAt: number;
  expiresAt: number;
}

const bookingApprovals = new Map<string, BookingApprovalState>();

/** Creates the Basic authorization header value used for PingOne CIBA calls. */
function buildBasicAuth(config: Config): string {
  return Buffer.from(`${config.cibaClientId}:${config.cibaClientSecret}`).toString("base64");
}

/** Generates the short approval code shown to the user during the CIBA flow. */
function createApprovalBindingMessage(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Starts a new backchannel approval request for a backend-owned booking intent. */
async function requestApprovalSession(
  config: Config,
  input: {
    loginHint: string;
    bindingMessage: string;
    customParameters?: Record<string, string>;
  }
): Promise<CibaAuthorizationResponse> {
  const params = new URLSearchParams({
    scope: config.cibaScope,
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
  logInfo(
    ["mcp", "ciba"],
    `authorization created transactionId=${input.customParameters?.transaction_id ?? ""} authReqId=${payload.auth_req_id} expiresIn=${payload.expires_in} interval=${payload.interval ?? ""}`
  );
  return payload;
}

/** Polls PingOne for the current state of a backchannel approval request. */
async function pollApprovalSession(
  config: Config,
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
      logInfo(["mcp", "ciba"], `approved accessTokenClaims=${JSON.stringify(accessTokenClaims)}`);
    } else {
      logInfo(["mcp", "ciba"], "approved access token is not a readable JWT");
    }

    const idTokenClaims = tokens.id_token ? decodeJwtClaimsForLogging(tokens.id_token) : null;
    if (idTokenClaims) {
      logInfo(["mcp", "ciba"], `approved idTokenClaims=${JSON.stringify(idTokenClaims)}`);
    } else if (tokens.id_token) {
      logInfo(["mcp", "ciba"], "approved id token is not a readable JWT");
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

function toApproval(state: BookingApprovalState): BookingApproval {
  const { ownerSub: _ownerSub, authRequestId: _authRequestId, nextPollAt: _nextPollAt, expiresAt: _expiresAt, ...approval } = state;
  return approval;
}

/** Starts MCP-owned approval for a backend-created booking transaction. */
export async function startBookingApproval(
  config: Config,
  input: {
    bookingIntent: BackendBookingIntent;
    ownerSub: string;
  }
): Promise<BookingApproval> {
  const bindingMessage = createApprovalBindingMessage();
  const cibaResponse = await requestApprovalSession(config, {
    loginHint: input.ownerSub,
    bindingMessage,
    customParameters: {
      transaction_id: input.bookingIntent.transactionId,
      hotel_id: input.bookingIntent.hotelId,
      hotel_name: input.bookingIntent.hotelName,
      check_in_date: input.bookingIntent.startDate,
      nights: String(input.bookingIntent.nights),
      amount: input.bookingIntent.totalPrice.toFixed(2),
      currency: input.bookingIntent.currency,
    },
  });

  const now = Date.now();
  const approvalState: BookingApprovalState = {
    transactionId: input.bookingIntent.transactionId,
    ownerSub: input.ownerSub,
    authRequestId: cibaResponse.auth_req_id,
    bindingMessage,
    hotelId: input.bookingIntent.hotelId,
    hotelName: input.bookingIntent.hotelName,
    startDate: input.bookingIntent.startDate,
    nights: input.bookingIntent.nights,
    nightlyRate: input.bookingIntent.nightlyRate,
    totalPrice: input.bookingIntent.totalPrice,
    currency: input.bookingIntent.currency,
    status: "pending_user_approval",
    updatedAt: new Date(now).toISOString(),
    pollIntervalSeconds: cibaResponse.interval ?? 2,
    nextPollAt: now + (cibaResponse.interval ?? 2) * 1000,
    expiresAt: now + cibaResponse.expires_in * 1000,
  };

  bookingApprovals.set(approvalState.transactionId, approvalState);
  return toApproval(approvalState);
}

/** Returns and refreshes the current MCP-owned approval state for a transaction. */
export async function getBookingApprovalStatus(
  config: Config,
  input: {
    transactionId: string;
    ownerSub: string;
  }
): Promise<BookingApproval | null> {
  const approvalState = bookingApprovals.get(input.transactionId);
  if (!approvalState || approvalState.ownerSub !== input.ownerSub) {
    return null;
  }

  if (approvalState.status !== "pending_user_approval") {
    return toApproval(approvalState);
  }

  const now = Date.now();
  if (now >= approvalState.expiresAt) {
    const expiredState: BookingApprovalState = {
      ...approvalState,
      status: "expired",
      updatedAt: new Date(now).toISOString(),
    };
    bookingApprovals.set(input.transactionId, expiredState);
    return toApproval(expiredState);
  }

  if (now < approvalState.nextPollAt) {
    return toApproval(approvalState);
  }

  const cibaStatus = await pollApprovalSession(config, approvalState.authRequestId);

  if (cibaStatus.kind === "approved") {
    const approvedState: BookingApprovalState = {
      ...approvalState,
      status: "approved",
      updatedAt: new Date(now).toISOString(),
      approvalCompletedAt: new Date(now).toISOString(),
      approvedScopes: cibaStatus.tokens.scope,
      hasRefreshToken: Boolean(cibaStatus.tokens.refresh_token),
    };
    bookingApprovals.set(input.transactionId, approvedState);
    return toApproval(approvedState);
  }

  if (cibaStatus.kind === "denied") {
    const deniedState: BookingApprovalState = {
      ...approvalState,
      status: "denied",
      updatedAt: new Date(now).toISOString(),
    };
    bookingApprovals.set(input.transactionId, deniedState);
    return toApproval(deniedState);
  }

  if (cibaStatus.kind === "expired") {
    const expiredState: BookingApprovalState = {
      ...approvalState,
      status: "expired",
      updatedAt: new Date(now).toISOString(),
    };
    bookingApprovals.set(input.transactionId, expiredState);
    return toApproval(expiredState);
  }

  const nextIntervalSeconds =
    cibaStatus.error === "slow_down"
      ? approvalState.pollIntervalSeconds + 5
      : approvalState.pollIntervalSeconds;

  const pendingState: BookingApprovalState = {
    ...approvalState,
    pollIntervalSeconds: nextIntervalSeconds,
    nextPollAt: now + nextIntervalSeconds * 1000,
    updatedAt: new Date(now).toISOString(),
  };
  bookingApprovals.set(input.transactionId, pendingState);
  return toApproval(pendingState);
}

/** Updates a locally approved transaction after the backend confirms the booking. */
export function markBookingApprovalConfirmed(bookingIntent: BackendBookingIntent): BookingApproval | null {
  const approvalState = bookingApprovals.get(bookingIntent.transactionId);
  if (!approvalState) {
    return null;
  }

  const confirmedState: BookingApprovalState = {
    ...approvalState,
    hotelId: bookingIntent.hotelId,
    hotelName: bookingIntent.hotelName,
    startDate: bookingIntent.startDate,
    nights: bookingIntent.nights,
    nightlyRate: bookingIntent.nightlyRate,
    totalPrice: bookingIntent.totalPrice,
    currency: bookingIntent.currency,
    status: "approved",
    updatedAt: bookingIntent.updatedAt,
    approvalCompletedAt: approvalState.approvalCompletedAt ?? bookingIntent.confirmedAt,
    backendBookingId: bookingIntent.backendBookingId,
    confirmedAt: bookingIntent.confirmedAt,
  };

  bookingApprovals.set(bookingIntent.transactionId, confirmedState);
  return toApproval(confirmedState);
}
