# Configuration Guide

This file contains setup and configuration instructions for running `MyHotels` with both the MCP server and the backend API server.

## Prerequisites

You need:

1. A PingOne environment
2. A ChatGPT account with MCP connector / developer support enabled
3. Node.js 18+
4. `ngrok` or another public HTTPS tunnel for local development
5. PingOne DaVinci
6. PingOne MFA or another PingOne-supported out-of-band approval method

## PingOne Setup

### Protected resource

Create a custom resource in PingOne:

- `Resource Name`: `Hotel MCP API`
- `Audience`: `hotel_mcp`
- `Description`: `MCP API for the MyHotels app`

Enable this scope:

- `my-hotels:mcp:member-access`

### ChatGPT / MCP client

Create one confidential OIDC application for ChatGPT access and MCP token exchange:

- `Application Type`: `OIDC Web App`
- Redirect URI: `https://chatgpt.com/connector_platform_oauth_redirect`
- Grant types:
  - `Authorization Code`
  - `Refresh Token`
  - `Client Credentials`
- Token endpoint auth method:
  - `Client Secret Basic` or `Client Secret Post`
- PKCE:
  - enabled / required

Attach the protected resource and enable:

- `my-hotels:mcp:member-access`

Use the same client credentials for:

- ChatGPT connector configuration
- `MCP_CLIENT_ID`
- `MCP_CLIENT_SECRET`

### Dedicated CIBA client

Create a second OIDC client for CIBA:

- `Application Type`: `OIDC Web App`
- enable `CIBA` grant type
- use a confidential token endpoint auth method
- attach the appropriate DaVinci CIBA flow policy

This client is used only by the backend API server when it initiates and polls CIBA.

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

# ChatGPT-facing MCP token requirements
MCP_AUDIENCE=hotel_mcp
MCP_SCOPE=my-hotels:mcp:member-access
MCP_CLIENT_ID=<pingone-mcp-client-id>
MCP_CLIENT_SECRET=<pingone-mcp-client-secret>

# Backend API token requirements
API_AUDIENCE=hotel_api
API_SCOPE=my-hotels:api:member-access

# PingOne CIBA client used by the backend API
CIBA_CLIENT_ID=<pingone-ciba-client-id>
CIBA_CLIENT_SECRET=<pingone-ciba-client-secret>

# CIBA scope used by the backend API
CIBA_SCOPE=openid my-hotels:api:book
```

How these values are used:

- ChatGPT authenticates to the MCP using the MCP-facing audience and scope.
- The MCP validates that ChatGPT token locally with JWKS.
- For protected backend calls, the MCP uses `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` to perform token exchange at the PingOne token endpoint.
- The exchanged token is requested for `API_AUDIENCE` and `API_SCOPE`.
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
- token exchange is enabled for the MCP client in PingOne
- the backend-translated token audience matches `API_AUDIENCE`
- the backend-translated token includes `API_SCOPE`

### CIBA setup issues

Check:

- the CIBA client is enabled for the CIBA grant
- the DaVinci flow policy is attached
- the CIBA endpoints are correct
- the CIBA scope and identity hint mapping match your PingOne setup
