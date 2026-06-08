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

## DaVinci Flow Setup

This project expects two DaVinci flows:

1. a user-authentication flow for ChatGPT access to the MCP protected resource
2. a CIBA approval flow for the backend approval journey

### Add the exported flow JSON files to the repo

Store the exported/importable DaVinci flow JSON files in:

- `davinci-flows/MyHotels - ChatGPT User Authentication.json`
- `davinci-flows/MyHotels - CIBA Approval via Magic Link.json`

These files are not used directly by the Node.js runtime. They are kept in the repo so the PingOne and DaVinci configuration is versioned together with the application.

### Import the flows into DaVinci

For each flow:

1. Open DaVinci in your PingOne environment.
2. Go to `Flows`.
3. Choose `Import`.
4. Import the JSON file from the repo.
5. Save the imported flow with a clear name.

Recommended names:

- `MyHotels ChatGPT User Authentication`
- `MyHotels CIBA Approval via Magic Link`

### Configure the user-authentication flow

Use the user-authentication flow for the ChatGPT-facing MCP application.

The flow should handle:

- primary user authentication
- any required MFA or step-up for the ChatGPT sign-in journey
- issuing the MCP-facing token for:
  - `MCP_AUDIENCE=myhotels-hotelmcp`
  - `MCP_SCOPE=my-hotels:mcp:member-access`

In DaVinci, review and update any environment-specific settings inside the imported flow, such as:

- PingOne environment or connection references
- MFA or authenticator connectors
- branding, redirect, or message text
- any policy nodes that reference specific app names, scopes, or audiences

### Attach the user-authentication flow to the ChatGPT application

In PingOne:

1. Open the ChatGPT-facing MCP application.
2. Go to the sign-on / authentication policy area for the application.
3. Select the DaVinci flow policy or authentication flow option.
4. Attach the imported `MyHotels ChatGPT User Authentication` flow.
5. Confirm that this application is attached to the MCP protected resource only.

The important separation is:

- the ChatGPT application uses the user-authentication flow
- it issues MCP-facing tokens
- it is not the token-exchange client
- it is not the CIBA client

### Configure the CIBA approval flow

Use the CIBA approval flow for the dedicated CIBA client.

The flow should handle:

- the out-of-band approval journey
- the user-facing approval prompt and decision
- any PingOne MFA / DaVinci steps needed to approve or deny the booking
- any display or branching logic based on the CIBA request context

In DaVinci, review and update environment-specific settings inside the imported flow, such as:

- PingOne environment or connection references
- approval prompt content
- MFA channels or authenticators
- any policy nodes that reference specific client IDs, redirect settings, or approval methods

### Attach the CIBA flow to the CIBA client

In PingOne:

1. Open the dedicated CIBA client.
2. Confirm that the `CIBA` grant type is enabled.
3. Open the DaVinci flow policy / CIBA policy configuration for the client.
4. Attach the imported `MyHotels CIBA Approval via Magic Link` flow.
5. Confirm that this client uses:
   - `CIBA_CLIENT_ID`
   - `CIBA_CLIENT_SECRET`

The important separation is:

- the CIBA client uses the CIBA approval flow
- the MCP token-exchange client does not use this flow
- the ChatGPT-facing MCP application does not use this flow

### Quick mapping summary

- ChatGPT-facing MCP application
  - protected resource: MCP resource
  - audience: `myhotels-hotelmcp`
  - scope: `my-hotels:mcp:member-access`
  - DaVinci flow: `MyHotels ChatGPT User Authentication`

- MCP token-exchange client
  - protected resource: backend API resource
  - audience requested during exchange: `myhotels-hotelapi`
  - scope requested during exchange: `my-hotels:api:member-access`
  - DaVinci flow: none in this project setup

- CIBA client
  - used by backend API for CIBA
  - CIBA scope: `openid my-hotels:api:book`
  - DaVinci flow: `MyHotels CIBA Approval via Magic Link`

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
