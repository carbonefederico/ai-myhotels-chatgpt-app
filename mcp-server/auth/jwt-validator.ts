/**
 * MCP-specific wrapper around the shared JWT validator.
 */
import { logError, logInfo } from "../logging.js";
import type { Config } from "../server.js";
import type { TokenClaims } from "../types.js";
import {
  summarizeValidatedClaims,
  validateJwtToken,
  type JwtValidationConfig,
} from "../../shared/jwt-validation.js";

/** Produces a compact claims summary for MCP-side auth debugging output. */
export function summarizeClaims(claims: TokenClaims): string {
  return summarizeValidatedClaims(claims);
}

/** Validates a bearer token against the MCP-facing PingOne audience and issuer. */
export async function validateToken(token: string, config: Config): Promise<TokenClaims> {
  const validationConfig: JwtValidationConfig = {
    issuer: config.authIssuer,
    jwksUrl: config.authJwksUrl,
    audience: config.mcpAudience,
  };

  return validateJwtToken(token, validationConfig, {
    info(message) {
      logInfo(["auth"], message);
    },
    error(message, error) {
      logError(["auth"], message, error);
    },
  });
}
