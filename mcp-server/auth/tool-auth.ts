/**
 * Tool-level auth helpers that validate bearer tokens and construct OAuth challenge responses.
 */
import { validateToken } from "./jwt-validator.js";
import { logInfo } from "../logging.js";
import { requestStorage } from "../server.js";
import type { Config } from "../server.js";
import type { TokenClaims } from "../types.js";

/** Splits the space-delimited OAuth scope claim into a normalized array. */
function getScopes(tokenInfo: TokenClaims): string[] {
  return tokenInfo.scope ? tokenInfo.scope.split(" ") : [];
}

/** Produces a concise claim summary for MCP-side auth logging. */
export function summarizeTokenClaims(tokenInfo: TokenClaims): string {
  return JSON.stringify({
    active: tokenInfo.active,
    scope: tokenInfo.scope,
    client_id: tokenInfo.client_id,
    sub: tokenInfo.sub,
    username: tokenInfo.username,
    given_name: tokenInfo.given_name,
    iss: tokenInfo.iss,
    aud: tokenInfo.aud,
    azp: tokenInfo.azp,
    exp: tokenInfo.exp,
    iat: tokenInfo.iat,
  });
}

/** Builds the Bearer challenge header advertised to ChatGPT when auth is missing or insufficient. */
export function buildWwwAuthenticateHeader(config: Config, options: {
  error?: string;
  scope?: string;
  errorDescription?: string;
}): string {
  const parts: string[] = [];

  if (options.error) {
    parts.push(`error="${options.error}"`);
  }

  if (options.scope) {
    parts.push(`scope="${options.scope}"`);
  }

  const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
  parts.push(`resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);

  if (options.errorDescription) {
    parts.push(`error_description="${options.errorDescription}"`);
  }

  return `Bearer ${parts.join(", ")}`;
}

/** Creates an MCP tool response that asks ChatGPT to obtain a valid access token. */
function buildAuthRequiredResponse(config: Config, scope: string, description: string) {
  return {
    content: [{
      type: "text" as const,
      text: "Sign in required for this action."
    }],
    _meta: {
      "mcp/www_authenticate": [
        buildWwwAuthenticateHeader(config, {
          error: "invalid_token",
          scope,
          errorDescription: description,
        })
      ]
    }
  };
}

/** Creates an MCP tool response that asks ChatGPT for a token with a broader scope set. */
function buildInsufficientScopeResponse(config: Config, scope: string, description: string) {
  return {
    content: [{
      type: "text" as const,
      text: "This action requires member booking access."
    }],
    _meta: {
      "mcp/www_authenticate": [
        buildWwwAuthenticateHeader(config, {
          error: "insufficient_scope",
          scope,
          errorDescription: description,
        })
      ]
    }
  };
}

/** Validates the current bearer token and enforces that the required scope is present. */
export async function requireTokenWithScope(config: Config, scope: string): Promise<
  | { ok: true; accessToken: string; tokenInfo: TokenClaims; scopes: string[] }
  | { ok: false; response: ReturnType<typeof buildAuthRequiredResponse> | ReturnType<typeof buildInsufficientScopeResponse> }
> {
  logInfo(['auth'], `requireTokenWithScope scope=${scope}`);
  const req = requestStorage.getStore();
  const authHeader = req?.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logInfo(['auth'], 'missing or invalid Authorization header');
    return {
      ok: false,
      response: buildAuthRequiredResponse(config, scope, `Scope ${scope} requires authentication.`),
    };
  }

  const token = authHeader.slice(7);
  const tokenInfo = await validateToken(token, config);

  if (!tokenInfo.active) {
    logInfo(['auth'], 'token inactive');
    return {
      ok: false,
      response: buildAuthRequiredResponse(config, scope, "Token is invalid or expired."),
    };
  }

  const scopes = getScopes(tokenInfo);
  if (!scopes.includes(scope)) {
    logInfo(['auth'], `insufficient scope required=${scope} actual=${scopes.join(",")}`);
    return {
      ok: false,
      response: buildInsufficientScopeResponse(config, scope, `Scope ${scope} is required.`),
    };
  }

  return {
    ok: true,
    accessToken: token,
    tokenInfo,
    scopes,
  };
}
