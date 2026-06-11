import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const source = readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(process.cwd(), ".env"));
loadEnvFile(resolve(process.cwd(), "tools/oidc-token-inspector/.env"));

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

const port = Number(process.env.OIDC_INSPECTOR_PORT || 3300);
if (Number.isNaN(port)) {
  throw new Error("OIDC_INSPECTOR_PORT must be a number");
}

const authServerUrl = required("AUTH_SERVER_URL");
const defaultClientId = process.env.OIDC_INSPECTOR_CLIENT_ID || process.env.MCP_CLIENT_ID || "";
const defaultClientSecret =
  process.env.OIDC_INSPECTOR_CLIENT_SECRET || process.env.MCP_CLIENT_SECRET || "";
const redirectUri =
  process.env.OIDC_INSPECTOR_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const defaultScope =
  process.env.OIDC_INSPECTOR_SCOPE ||
  `openid profile offline_access ${[process.env.MCP_MEMBER_RATES_SCOPE, process.env.MCP_BOOK_SCOPE].filter(Boolean).join(" ")}`.trim();
const defaultAudience = process.env.OIDC_INSPECTOR_AUDIENCE || process.env.MCP_AUDIENCE || "";

const authorizeEndpoint = `${authServerUrl}/authorize`;
const tokenEndpoint = `${authServerUrl}/token`;

const sessions = new Map();

function toBase64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createPkceVerifier() {
  return toBase64Url(randomBytes(32));
}

function createPkceChallenge(verifier) {
  return toBase64Url(createHash("sha256").update(verifier).digest());
}

function decodeJwtClaims(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return JSON.parse(Buffer.from(normalized + padding, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f6f6; color:#111; margin:0; padding:32px; }
      main { max-width: 920px; margin: 0 auto; background:#fff; border:1px solid #ddd; border-radius:18px; padding:28px; }
      h1, h2 { margin-top:0; }
      .meta { color:#666; font-size:14px; }
      .actions { margin: 24px 0; }
      a.button, button { display:inline-block; background:#111; color:#fff; text-decoration:none; border:none; border-radius:999px; padding:12px 18px; font-size:14px; cursor:pointer; }
      pre, textarea { width:100%; box-sizing:border-box; background:#fafafa; border:1px solid #ddd; border-radius:12px; padding:14px; font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
      textarea { min-height:120px; resize:vertical; }
      section { margin-top:24px; }
      code { background:#f0f0f0; border-radius:6px; padding:2px 6px; }
      .grid { display:grid; gap:18px; }
      .warn { background:#fff8e6; border:1px solid #eed48a; border-radius:12px; padding:14px; }
    </style>
  </head>
  <body>
    <main>
      ${body}
    </main>
  </body>
</html>`;
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendRedirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

async function readFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  return new URLSearchParams(bodyText);
}

function buildAuthorizeUrl(loginConfig) {
  const state = toBase64Url(randomBytes(24));
  const nonce = toBase64Url(randomBytes(24));
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);

  sessions.set(state, {
    codeVerifier,
    nonce,
    createdAt: Date.now(),
    loginConfig,
  });

  const params = new URLSearchParams({
    client_id: loginConfig.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: loginConfig.scope,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (loginConfig.audience) {
    params.set("audience", loginConfig.audience);
  }

  return `${authorizeEndpoint}?${params.toString()}`;
}

async function exchangeCodeForTokens({ code, codeVerifier, clientId, clientSecret }) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: params.toString(),
  });

  const bodyText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}\n${bodyText}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Token endpoint returned a non-JSON body:\n${bodyText}`);
  }

  return parsed;
}

function renderHome() {
  const note = `
        <div class="warn">
          <strong>PingOne setup note:</strong> the same OIDC client must allow this redirect URI:
          <code>${escapeHtml(redirectUri)}</code>
        </div>`;

  return renderPage(
    "OIDC Token Inspector",
    `
      <h1>OIDC Token Inspector</h1>
      <p class="meta">Standalone utility. It does not modify or run the main MyHotels app.</p>
      ${note}
      <section>
        <h2>Inspector settings</h2>
        <div class="grid">
          <div>Authorization server: <code>${escapeHtml(authServerUrl)}</code></div>
          <div>Redirect URI: <code>${escapeHtml(redirectUri)}</code></div>
        </div>
      </section>
      <section>
        <form action="/login" method="POST" id="login-form" class="grid">
          <label>
            <div>Client ID</div>
            <input id="clientId" name="clientId" type="text" value="${escapeHtml(defaultClientId)}" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd;border-radius:12px;" />
          </label>
          <label>
            <div>Client Secret</div>
            <input id="clientSecret" name="clientSecret" type="password" value="${escapeHtml(defaultClientSecret)}" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd;border-radius:12px;" />
            <div class="meta">Not saved in local storage.</div>
          </label>
          <label>
            <div>Scopes</div>
            <input id="scope" name="scope" type="text" value="${escapeHtml(defaultScope)}" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd;border-radius:12px;" />
          </label>
          <label>
            <div>Audience</div>
            <input id="audience" name="audience" type="text" value="${escapeHtml(defaultAudience)}" style="width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #ddd;border-radius:12px;" />
          </label>
          <div class="actions">
            <button type="submit">Start OIDC login</button>
          </div>
        </form>
      </section>
      <script>
        (() => {
          const storageKey = "oidc-token-inspector-settings";
          const form = document.getElementById("login-form");
          const persistedFields = ["clientId", "scope", "audience"];
          try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
            for (const field of persistedFields) {
              const element = document.getElementById(field);
              if (element && typeof saved[field] === "string" && saved[field]) {
                element.value = saved[field];
              }
            }
          } catch {}

          form?.addEventListener("submit", () => {
            const nextValue = {};
            for (const field of persistedFields) {
              const element = document.getElementById(field);
              if (element) {
                nextValue[field] = element.value;
              }
            }
            localStorage.setItem(storageKey, JSON.stringify(nextValue));
          });
        })();
      </script>
    `
  );
}

function renderTokenResult(tokens, stateRecord) {
  const idTokenClaims = decodeJwtClaims(tokens.id_token);
  const accessTokenClaims = decodeJwtClaims(tokens.access_token);
  const refreshTokenClaims = decodeJwtClaims(tokens.refresh_token);
  const nonceFromIdToken = idTokenClaims && typeof idTokenClaims.nonce === "string" ? idTokenClaims.nonce : null;
  const nonceStatus =
    stateRecord?.nonce && nonceFromIdToken
      ? nonceFromIdToken === stateRecord.nonce
        ? "matched"
        : `mismatch expected=${stateRecord.nonce} received=${nonceFromIdToken}`
      : "not available";

  return renderPage(
    "OIDC Tokens",
    `
      <h1>OIDC Token Result</h1>
      <p class="meta">Returned by PingOne for the existing ChatGPT / MCP client.</p>
      <div class="actions">
        <a class="button" href="/">Back</a>
      </div>

      <section>
        <h2>Summary</h2>
        <pre>${escapeHtml(
          JSON.stringify(
            {
              client_id: stateRecord?.loginConfig?.clientId,
              audience: stateRecord?.loginConfig?.audience || "",
              requested_scope: stateRecord?.loginConfig?.scope,
              token_type: tokens.token_type,
              scope: tokens.scope,
              expires_in: tokens.expires_in,
              has_access_token: Boolean(tokens.access_token),
              has_id_token: Boolean(tokens.id_token),
              has_refresh_token: Boolean(tokens.refresh_token),
              nonce_check: nonceStatus,
            },
            null,
            2
          )
        )}</pre>
      </section>

      <section>
        <h2>Access token claims</h2>
        <pre>${escapeHtml(JSON.stringify(accessTokenClaims, null, 2) || "Token is not a readable JWT")}</pre>
      </section>

      <section>
        <h2>ID token claims</h2>
        <pre>${escapeHtml(JSON.stringify(idTokenClaims, null, 2) || "Token is not a readable JWT")}</pre>
      </section>

      <section>
        <h2>Refresh token claims</h2>
        <pre>${escapeHtml(JSON.stringify(refreshTokenClaims, null, 2) || "Token is not a readable JWT")}</pre>
      </section>

      <section>
        <h2>Raw token payload</h2>
        <pre>${escapeHtml(JSON.stringify(tokens, null, 2))}</pre>
      </section>

      <section>
        <h2>Raw access token</h2>
        <textarea readonly>${escapeHtml(tokens.access_token || "")}</textarea>
      </section>

      <section>
        <h2>Raw ID token</h2>
        <textarea readonly>${escapeHtml(tokens.id_token || "")}</textarea>
      </section>

      <section>
        <h2>Raw refresh token</h2>
        <textarea readonly>${escapeHtml(tokens.refresh_token || "")}</textarea>
      </section>
    `
  );
}

function renderError(error) {
  return renderPage(
    "OIDC Error",
    `
      <h1>OIDC Error</h1>
      <pre>${escapeHtml(error instanceof Error ? error.stack || error.message : String(error))}</pre>
      <div class="actions">
        <a class="button" href="/">Back</a>
      </div>
    `
  );
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/") {
      sendHtml(res, renderHome());
      return;
    }

    if (url.pathname === "/login") {
      if (req.method !== "POST") {
        sendHtml(res, renderError("Use POST /login to submit credentials"), 405);
        return;
      }

      const formData = await readFormBody(req);
      const loginConfig = {
        clientId: (formData.get("clientId") || defaultClientId).toString().trim(),
        clientSecret: (formData.get("clientSecret") || defaultClientSecret).toString().trim(),
        scope: (formData.get("scope") || defaultScope).toString().trim(),
        audience: (formData.get("audience") || defaultAudience).toString().trim(),
      };

      if (!loginConfig.clientId) {
        sendHtml(res, renderError("Client ID is required"), 400);
        return;
      }

      if (!loginConfig.clientSecret) {
        sendHtml(res, renderError("Client secret is required"), 400);
        return;
      }

      if (!loginConfig.scope) {
        sendHtml(res, renderError("At least one scope is required"), 400);
        return;
      }

      sendRedirect(res, buildAuthorizeUrl(loginConfig));
      return;
    }

    if (url.pathname === "/auth/callback") {
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        sendHtml(res, renderError(`${error}\n${errorDescription || ""}`), 400);
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) {
        sendHtml(res, renderError("Missing state or code"), 400);
        return;
      }

      const stateRecord = sessions.get(state);
      sessions.delete(state);

      if (!stateRecord) {
        sendHtml(res, renderError("Unknown or expired state"), 400);
        return;
      }

      const tokens = await exchangeCodeForTokens({
        code,
        codeVerifier: stateRecord.codeVerifier,
        clientId: stateRecord.loginConfig.clientId,
        clientSecret: stateRecord.loginConfig.clientSecret,
      });

      sendHtml(res, renderTokenResult(tokens, stateRecord));
      return;
    }

    sendHtml(res, renderError("Not found"), 404);
  } catch (error) {
    sendHtml(res, renderError(error), 500);
  }
});

server.listen(port, () => {
  console.log(`[oidc-inspector] listening on http://localhost:${port}`);
  console.log(`[oidc-inspector] authorize endpoint: ${authorizeEndpoint}`);
  console.log(`[oidc-inspector] token endpoint: ${tokenEndpoint}`);
  console.log(`[oidc-inspector] redirect URI: ${redirectUri}`);
});
