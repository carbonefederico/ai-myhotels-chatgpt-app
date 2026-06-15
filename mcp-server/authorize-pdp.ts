/**
 * PingOne Authorize PDP client used by MCP tools for centralized policy decisions.
 */
import { logInfo } from "./logging.js";
import { requestStorage, type Config } from "./server.js";

interface AuthorizeTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

export interface AuthorizeDecisionResponse {
  correlationId?: string;
  timestamp?: string;
  elapsedMicroseconds?: number;
  decision?: string;
  status?: {
    code?: string;
    message?: string;
  };
  statements?: AuthorizeStatement[];
  authorizationVersion?: Record<string, unknown>;
}

export interface AuthorizeStatement {
  name?: string;
  code?: string;
  payload?: unknown;
  obligatory?: boolean;
  fulfilled?: boolean;
}

interface CachedAuthorizeToken {
  accessToken: string;
  expiresAt: number;
}

let cachedAuthorizeToken: CachedAuthorizeToken | null = null;

const SENSITIVE_KEY_PATTERN = /token|authorization|credential|secret|password/i;

export class AuthorizeDeniedError extends Error {
  constructor(
    readonly resource: string,
    readonly decision: string,
    readonly statusCode: string,
    readonly correlationId?: string,
    readonly statements: AuthorizeStatement[] = []
  ) {
    super(`Authorize denied ${resource}: decision=${decision} status=${statusCode} correlationId=${correlationId ?? ""}`);
    this.name = "AuthorizeDeniedError";
  }
}

export function requiresHumanInTheLoop(decision: AuthorizeDecisionResponse): boolean {
  return Boolean(
    decision.statements?.some((statement) =>
      statement.code === "USER-AZ-REQUIRED" &&
      statement.obligatory === true &&
      statement.fulfilled === false
    )
  );
}

function buildBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function obfuscate(value: string): string {
  if (!value) {
    return "";
  }

  if (value.length <= 12) {
    return "***";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi, (_match, token: string) => `Bearer ${obfuscate(token)}`)
    .replace(/\bBasic\s+([A-Za-z0-9+/=._~-]+)/gi, (_match, token: string) => `Basic ${obfuscate(token)}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, (token) => obfuscate(token));
}

function maskSensitiveValues(value: unknown, parentKey = ""): unknown {
  if (typeof value === "string") {
    return SENSITIVE_KEY_PATTERN.test(parentKey) ? obfuscate(value) : redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveValues(item, parentKey));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? obfuscate(String(entry ?? "")) : maskSensitiveValues(entry, key),
      ])
    );
  }

  return value;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(maskSensitiveValues(value), null, 2);
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function flattenAuthorizeParameters(
  parameters: Record<string, unknown> | undefined,
  prefix = "MyHotels.parameters"
): Record<string, unknown> {
  if (!parameters) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (value === undefined) {
        return [];
      }

      const parameterName = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.entries(flattenAuthorizeParameters(value as Record<string, unknown>, parameterName));
      }

      return [[parameterName, Array.isArray(value) ? JSON.stringify(value) : value]];
    })
  );
}

export function readInboundBearerToken(): string {
  const req = requestStorage.getStore();
  const authHeader = req?.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return "";
  }
  return authHeader.slice(7);
}

async function getAuthorizeAccessToken(config: Config): Promise<string> {
  const now = Date.now();
  if (cachedAuthorizeToken && cachedAuthorizeToken.expiresAt > now) {
    return cachedAuthorizeToken.accessToken;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "openid",
  });
  const tokenRequestBody = params.toString();
  const tokenRequestLog = {
    url: config.tokenEndpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${buildBasicAuth(config.authorizeClientId, config.authorizeClientSecret)}`,
    },
    body: Object.fromEntries(params.entries()),
  };

  logInfo(
    ["authorize", "token-request"],
    `request=\n${prettyJson(tokenRequestLog)}`
  );

  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${buildBasicAuth(config.authorizeClientId, config.authorizeClientSecret)}`,
    },
    body: tokenRequestBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logInfo(
      ["authorize", "token-response"],
      `response=\n${prettyJson({
        status: response.status,
        statusText: response.statusText,
        body: parseJsonOrText(errorText),
      })}`
    );
    throw new Error(`Authorize token request failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  const payload = (await response.json()) as AuthorizeTokenResponse;
  if (!payload.access_token) {
    throw new Error("Authorize token request did not return an access token");
  }

  cachedAuthorizeToken = {
    accessToken: payload.access_token,
    expiresAt: now + Math.max((payload.expires_in ?? 60) - 5, 5) * 1000,
  };

  logInfo(
    ["authorize", "token-response"],
    `response=\n${prettyJson({
      status: response.status,
      body: payload,
    })}`
  );
  return payload.access_token;
}

/** Calls PingOne Authorize and throws unless the decision is PERMIT. */
export async function requireAuthorizeDecision(
  config: Config,
  input: {
    resource: string;
    parameters?: Record<string, unknown>;
  }
): Promise<AuthorizeDecisionResponse> {
  const authorizeAccessToken = await getAuthorizeAccessToken(config);
  const bearerToken = readInboundBearerToken();
  const requestBody = {
    parameters: {
      "MyHotels.service": config.mcpAudience,
      "MyHotels.resource": input.resource,
      ...flattenAuthorizeParameters(input.parameters),
      "MyHotels.bearerToken": bearerToken,
    },
  };
  const decisionRequestBody = JSON.stringify(requestBody);
  const decisionRequestLog = {
    url: config.authorizeDecisionEndpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authorizeAccessToken}`,
    },
    body: requestBody,
  };

  logInfo(
    ["authorize", "decision-request"],
    `request=\n${prettyJson(decisionRequestLog)}`
  );

  const response = await fetch(config.authorizeDecisionEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authorizeAccessToken}`,
    },
    body: decisionRequestBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logInfo(
      ["authorize", "decision-response"],
      `response=\n${prettyJson({
        resource: input.resource,
        status: response.status,
        statusText: response.statusText,
        body: parseJsonOrText(errorText),
      })}`
    );
    throw new Error(`Authorize decision request failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  const decision = (await response.json()) as AuthorizeDecisionResponse;
  logInfo(
    ["authorize", "decision-response"],
    `response=\n${prettyJson({
      resource: input.resource,
      status: response.status,
      body: decision,
    })}`
  );

  if (decision.decision !== "PERMIT") {
    throw new AuthorizeDeniedError(
      input.resource,
      decision.decision ?? "UNKNOWN",
      decision.status?.code ?? "",
      decision.correlationId,
      decision.statements ?? []
    );
  }

  return decision;
}
