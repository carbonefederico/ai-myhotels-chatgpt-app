# OIDC Token Inspector

This is a standalone utility for testing the PingOne OIDC login flow.

It is intentionally separate from the main app so the production-facing MCP and widget code stay clean.

## What it does

- starts a tiny local HTTP app
- redirects the browser to PingOne `/authorize`
- exchanges the authorization code at `/token`
- shows:
  - raw token endpoint payload
  - raw access token
  - raw ID token
  - raw refresh token
  - decoded JWT claims when a token is a readable JWT

## Required PingOne setup

Whatever client you test with must allow this local redirect URI:

```text
http://localhost:3300/auth/callback
```

If you use a different port or redirect URI, set `OIDC_INSPECTOR_PORT` or `OIDC_INSPECTOR_REDIRECT_URI` and add that exact URI to the PingOne client.

## Environment

The utility reads the root `.env` file automatically and uses:

- `AUTH_SERVER_URL`

Optional overrides:

- `OIDC_INSPECTOR_PORT`
- `OIDC_INSPECTOR_REDIRECT_URI`
- `OIDC_INSPECTOR_SCOPE`
- `OIDC_INSPECTOR_AUDIENCE`
- `OIDC_INSPECTOR_CLIENT_ID`
- `OIDC_INSPECTOR_CLIENT_SECRET`

Default values shown in the page:

```text
client_id: OIDC_INSPECTOR_CLIENT_ID or MCP_CLIENT_ID
client_secret: OIDC_INSPECTOR_CLIENT_SECRET or MCP_CLIENT_SECRET
scope: openid profile offline_access <MCP_MEMBER_RATES_SCOPE> <MCP_BOOK_SCOPE>
audience: OIDC_INSPECTOR_AUDIENCE or MCP_AUDIENCE
```

You can change the client ID, client secret, scopes, and audience directly in the web page.
The inspector stores `client_id`, `scope`, and `audience` in browser local storage so you do not have to re-enter them each time.
It does not persist the client secret.

## Run

From the repository root:

```bash
node tools/oidc-token-inspector/server.mjs
```

Then open:

```text
http://localhost:3300
```

## Notes

- This utility does not validate token signatures. It only decodes JWT payloads for inspection.
- If PingOne returns opaque tokens, the raw token will still be shown, but claims will not be decoded.
