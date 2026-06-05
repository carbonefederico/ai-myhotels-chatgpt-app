# Configuration Guide

This file contains setup and configuration guidance for running `MyHotels` with both the MCP server and the backend API server.

## Prerequisites

You need:

1. A PingOne environment
2. A ChatGPT account with MCP connector / developer support enabled
3. Node.js 18+
4. `ngrok` or another public HTTPS tunnel for local development
5. PingOne DaVinci
6. PingOne MFA or another PingOne-supported out-of-band approval method

## PingOne Setup

### MCP protected resource

Create a custom resource in PingOne for the MCP-facing access token:

- `Resource Name`: `MyHotels MCP Resource`
- `Audience`: `myhotels-hotelmcp`
- `Description`: `MCP-facing protected resource for the MyHotels app`

Enable this scope:

- `my-hotels:mcp:member-access`

### Backend API protected resource

Create a second custom resource in PingOne for the backend API:

- `Resource Name`: `MyHotels API Resource`
- `Audience`: `myhotels-hotelapi`
- `Description`: `Backend API protected resource for the MyHotels app`

Enable this scope:

- `my-hotels:api:member-access`

### ChatGPT agent

Create an AI Agent for ChatGPT to the MCP resource only:

- Redirect URI: `https://chatgpt.com/connector_platform_oauth_redirect`
- Grant types:
  - `Authorization Code`
  - `Refresh Token`
- Token endpoint auth method:
  - `Client Secret Basic`


Attach the MCP protected resource and enable:

- `my-hotels:mcp:member-access`

Important:

- this ChatGPT client is used only in the ChatGPT connector configuration
- it is **not** the client configured in `.env`
- it is **not** used by the MCP server for token exchange

### MCP token-exchange client for the API resource

Create a confidential OIDC application used by the MCP server to exchange the ChatGPT token for a backend API token:

- `Application Type`: `OIDC Web App` or another confidential client type supported by your PingOne setup
- Grant types:
  - `Token Exchange`
- Token endpoint auth method:
  - `Client Secret Basic`

Attach the backend API protected resource and enable:

- `my-hotels:api:member-access`

Use this application's credentials for:

- `MCP_CLIENT_ID`
- `MCP_CLIENT_SECRET`

This client is used only by the MCP server when it calls the PingOne token endpoint for backend API token exchange.

### Dedicated CIBA client

Create an OIDC client for CIBA:

- `Application Type`: `OIDC Web App`
- enable `CIBA` grant type
- use a confidential token endpoint auth method
- attach the appropriate DaVinci CIBA flow policy

This client is used only by the backend API server when it initiates and polls CIBA.

Use this application's credentials for:

- `CIBA_CLIENT_ID`
- `CIBA_CLIENT_SECRET`

This is a separate client from the MCP token-exchange client. Even though both use client credentials at the token endpoint, they serve different purposes:

- `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET`
  - used by the MCP server for OAuth token exchange
  - used to obtain backend API tokens
- `CIBA_CLIENT_ID` / `CIBA_CLIENT_SECRET`
  - used by the backend API for CIBA authorization and polling
  - used to start and complete the approval flow

## Environment Variables

Create a `.env` file in the project root:

```bash
# MCP server
MCP_PORT=3100
PUBLIC_URL=http://localhost:3100

# Backend API server
API_PORT=3200
API_BASE_URL=http://localhost:3200

# PingOne authorization server base URL
AUTH_SERVER_URL=https://auth.pingone.eu/<environment-id>/as

# MCP protected resource token requirements
MCP_AUDIENCE=myhotels-hotelmcp
MCP_SCOPE=my-hotels:mcp:member-access
MCP_CLIENT_ID=<pingone-mcp-token-exchange-client-id>
MCP_CLIENT_SECRET=<pingone-mcp-token-exchange-client-secret>

# Backend API token requirements
API_AUDIENCE=myhotels-hotelapi
API_SCOPE=my-hotels:api:member-access

# PingOne CIBA client used by the backend API
CIBA_CLIENT_ID=<pingone-ciba-client-id>
CIBA_CLIENT_SECRET=<pingone-ciba-client-secret>

# CIBA scope used by the backend API
CIBA_SCOPE=openid my-hotels:api:book
```

How these values are used:

- ChatGPT authenticates to the MCP using the separate ChatGPT connector client attached to the MCP protected resource.
- The MCP validates that ChatGPT token locally with JWKS against `MCP_AUDIENCE` and `MCP_SCOPE`.
- For protected backend calls, the MCP uses `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` from the separate MCP token-exchange client.
- That token exchange requests a backend API token for `API_AUDIENCE` and `API_SCOPE`.
- The backend API validates that exchanged token locally with JWKS.
- The backend API uses the separate CIBA client to start and poll approval sessions.

Important:

- `AUTH_SERVER_URL` must be the authorization server base URL
- do not point it at `/authorize`

Correct example:

```text
https://auth.pingone.eu/<environment-id>/as
```

Incorrect example:

```text
https://auth.pingone.eu/<environment-id>/as/authorize
```

## Install and Run

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run locally:

```bash
npm run dev
```

## Local Widget Testing

Raw widget:

```text
http://localhost:3100/widget/hotel-search
```

## Expose the App Publicly

Start a tunnel:

```bash
ngrok http 3100
```

Update `PUBLIC_URL` in `.env` to the public HTTPS URL and restart the app.

Example:

```bash
PUBLIC_URL=https://abc123.ngrok-free.app
```

Verify the protected-resource metadata:

```bash
curl https://abc123.ngrok-free.app/.well-known/oauth-protected-resource
```

## Connect from ChatGPT

Add the MCP connector in ChatGPT using:

```text
https://<your-public-url>/mcp
```

If ChatGPT does not pick up tool changes after redeploy, use the refresh control in the ChatGPT UI.

## Troubleshooting

### ChatGPT cannot connect

Check:

- the server is running
- the tunnel is live
- `PUBLIC_URL` matches the actual public URL
- `/.well-known/oauth-protected-resource` is reachable over HTTPS

### Protected calls fail with token problems

Check:

- `AUTH_SERVER_URL`
- the user token includes your configured `MCP_SCOPE`
- the MCP token audience matches `MCP_AUDIENCE`
- the ChatGPT connector client is attached to the MCP protected resource, not the API resource
- token exchange is enabled for the separate MCP token-exchange client in PingOne
- the backend-translated token audience matches `API_AUDIENCE`
- the backend-translated token includes `API_SCOPE`

### CIBA setup issues

Check:

- the CIBA client is enabled for the CIBA grant
- the DaVinci flow policy is attached
- the CIBA endpoints are correct
- the CIBA scope and identity hint mapping match your PingOne setup
