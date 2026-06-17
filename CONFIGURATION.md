# Configuration Guidelines

This file contains setup and configuration **guidance** for running `MyHotels` with both the MCP server and the backend API server. Previous knowledge of PingOne and PingOne Authorize is required as this is not a detailed step-by-step tutorial.

## Prerequisites

You need:

1. A PingOne environment
2. A ChatGPT account with MCP connector / developer support enabled
3. Node.js 18+
4. `ngrok` or another public HTTPS tunnel for local development
5. PingOne DaVinci
6. PingOne MFA or another PingOne-supported out-of-band approval method

## PingOne Setup

### Test user and test group

Create a PingOne group for demo users:

- `Group Name`: `ChatGPT User`

Create a test user for the demo and assign that user to the `ChatGPT User` group.

Use this test user when signing in through ChatGPT. The MCP and backend API resource mappings include `groups -> PingOne Group Names`, so the issued tokens should include the `ChatGPT User` group name after authentication and token exchange.

### MCP protected resource

Create a custom resource in PingOne for the MCP-facing access token:

- `Resource Name`: `MyHotels MCP Resource`
- `Audience`: `myhotels-hotelmcp`
- `Description`: `MCP-facing protected resource for the MyHotels app`

Enable these scopes:

- `my-hotels:mcp:member_rates`
- `my-hotels:mcp:book`

Map the MCP resource attributes so ChatGPT receives the user identity claims needed by the app.

Required mappings:
- `act` -> advanced expression:
  ```text
  ({ "sub": #root.context.appConfig.clientId })
  ```
- `given_name` -> PingOne `Given Name`
- `groups` -> PingOne `Group Names`
- `sub` -> PingOne `Username`

The `act` expression identifies the ChatGPT connector client as the actor in the MCP-facing token. The `given_name`, `groups`, and `sub` mappings preserve the authenticated user's profile, group names, and username for MCP policy and demo context.

### Backend API protected resource

Create a second custom resource in PingOne for the backend API:

- `Resource Name`: `MyHotels API Resource`
- `Audience`: `myhotels-hotelapi`
- `Description`: `Backend API protected resource for the MyHotels app`

Enable these scopes:

- `my-hotels:api:member_rates`
- `my-hotels:api:book`

Map the backend API resource attributes so exchanged API tokens preserve the user identity and include delegation context.

Required mappings:
- `act` -> advanced expression:
  ```text
  ({ "sub": #root.context.appConfig.clientId, "act": {"sub": #root.context.requestData.subjectToken.client_id}})
  ```
- `groups` -> PingOne `Group Names`
- `sub` -> PingOne `Username`

The `sub` mapping keeps the authenticated user as the backend API token subject. The `groups` mapping preserves the authenticated user's PingOne group names for backend authorization context. The `act` expression sets the backend API token actor to the MCP token-exchange client and nests the ChatGPT client from the incoming subject token as the prior actor.

Expected token claim shape:

- ChatGPT-facing MCP token:
  ```json
  {
    "sub": "<username>",
    "given_name": "<given-name>",
    "groups": ["<group-name>"],
    "act": {
      "sub": "<chatgpt-connector-client-id>"
    }
  }
  ```
- Exchanged backend API token:
  ```json
  {
    "sub": "<username>",
    "groups": ["<group-name>"],
    "act": {
      "sub": "<mcp-token-exchange-client-id>",
      "act": {
        "sub": "<chatgpt-connector-client-id>"
      }
    }
  }
  ```

### ChatGPT agent

Create an AI Agent for ChatGPT to the MCP resource only:

- Redirect URI: use the exact redirect URI shown in the ChatGPT connector configuration
- Grant types:
  - `Authorization Code`
  - `Refresh Token`
- Token endpoint auth method:
  - `Client Secret Basic`

The redirect URI must match the ChatGPT-provided value exactly. Do not copy a redirect URI from another connector or environment.


Attach the MCP protected resource and enable:

- `my-hotels:mcp:member_rates`
- `my-hotels:mcp:book`

Important:

- this ChatGPT client is used only in the ChatGPT connector configuration
- it is **not** the client configured in `.env`
- it is **not** used by the MCP server for token exchange

### MCP token-exchange client for the API resource

Create a confidential OIDC application used by the MCP server to exchange the ChatGPT token for a backend API token:

- `Application Type`: `OIDC Web App`
- Grant types:
  - `Token Exchange`
- Token endpoint auth method:
  - `Client Secret Basic`

Attach the backend API protected resource and enable:

- `my-hotels:api:member_rates`
- `my-hotels:api:book`

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

Attach the backend API protected resource and enable:

- `my-hotels:api:book`

This scope must match `CIBA_SCOPE=openid my-hotels:api:book`. The CIBA client does not need the member-rates scope because it is used only for booking approval.

This client is used only by the MCP server when it initiates and polls CIBA for agent-initiated booking approval.

Use this application's credentials for:

- `CIBA_CLIENT_ID`
- `CIBA_CLIENT_SECRET`

This is a separate client from the MCP token-exchange client. Even though both use client credentials at the token endpoint, they serve different purposes:

- `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET`
  - used by the MCP server for OAuth token exchange
  - used to obtain backend API tokens
- `CIBA_CLIENT_ID` / `CIBA_CLIENT_SECRET`
  - used by the MCP server for CIBA authorization and polling
  - used to start and complete the approval flow

### PingOne Authorize client

Create a confidential OIDC application that the MCP server uses to call the PingOne Authorize decision endpoint:

- `Application Type`: `OIDC Web App`
- Grant types:
  - `Client Credentials`
- Token endpoint auth method:
  - `Client Secret Basic`

Use this application's credentials for:

- `AUTHORIZE_CLIENT_ID`
- `AUTHORIZE_CLIENT_SECRET`

### PingOne Authorize trust framework and policies

Configure PingOne Authorize with a `MyHotels` trust framework that models the MCP request and the ChatGPT-facing bearer token.

Trust framework service:

- `PingOne Token Introspection`
  - service type: `HTTP`
  - target URL: the PingOne authorization server introspection endpoint, for example `https://auth.pingone.eu/<environment-id>/as/introspect`
  - method: `POST`
  - content type: `application/x-www-form-urlencoded`
  - body: `token={{MyHotels.bearerToken}}`
  - `Authorization` header: Basic introspection credentials (the client id and secret are obtained from the PingOne MCP Resource using the MCP resource ID and the introspection secret) 
  - certificate validation: `On`

Trust framework attributes:

- `MyHotels.bearerToken`: request parameter containing the inbound ChatGPT bearer token.
- `MyHotels.service`: request parameter containing the MCP audience, such as `myhotels-hotelmcp`.
- `MyHotels.resource`: request parameter containing the MCP tool name, such as `search_hotels`, `search_hotels_member_rates`, `prepare_booking`, or `finalize_booking`.
- `MyHotels.parameters.*`: request parameters for selected tool arguments. The booking policy uses values such as `MyHotels.parameters.totalPrice`.
- `Introspected Token.Actor Subject`: resolved from the introspection response actor claim, for example JSON path `$.act.sub`.
- `Introspected Token.Audience`: resolved from the introspected token audience.
- `Introspected Token.Client Id`: resolved from the introspected token client identifier.
- `Introspected Token.Scopes`: resolved from the introspected token scopes.
- `Introspected Token.Subject Groups`: resolved from the introspected token group names. Use an empty collection as the default when no groups are present.

Create reusable named conditions for the protected-tool policies:

- `User is a ChatGPT user`: verifies that `Introspected Token.Subject Groups` contains the expected ChatGPT user group, such as `ChatGPT User`.
- `Token was issued to ChatGPT`: verifies that `Introspected Token.Actor Subject` matches the ChatGPT connector client ID.
- `Token is for the Hotel MCP`: verifies that `Introspected Token.Audience` contains `myhotels-hotelmcp`.
- `Token has the member rates permission`: verifies that `Introspected Token.Scopes` contains `my-hotels:mcp:member_rates`.
- `Token has the booking initialization permission`: verifies that `Introspected Token.Scopes` contains `my-hotels:mcp:book`.
- `Token has finalize payment permission`: verifies that `Introspected Token.Scopes` contains `my-hotels:mcp:book` for booking finalization.

Create the policy tree under `Policies -> MyHotels -> MCP Server`:

- `Public Tools`
  - applies when `MyHotels.resource` equals `search_hotels`
  - first-applicable combining algorithm
  - rule: `Permit`
- `Protected Tools`
  - child policy: `Allow ChatGPT Member Rates Access`
    - applies when `MyHotels.resource` equals `search_hotels_member_rates`
    - single-deny-overrides combining algorithm
    - rules require the ChatGPT user, ChatGPT-issued token, Hotel MCP audience, and member-rates scope
  - child policy: `Allow ChatGPT Booking Initialization Access`
    - applies when `MyHotels.resource` equals `prepare_booking`
    - single-deny-overrides combining algorithm
    - rules require the ChatGPT user, ChatGPT-issued token, Hotel MCP audience, and booking scope
    - amount rules:
      - allow payments below `200 EUR`
      - return a Human in the Loop obligation above `200 EUR`
      - deny payments above `1000 EUR`
  - child policy: `Allow ChatGPT Booking Finalize Access`
    - applies when `MyHotels.resource` equals `finalize_booking`
    - single-deny-overrides combining algorithm
    - rules require the ChatGPT user, ChatGPT-issued token, Hotel MCP audience, and booking/finalize scope
  - child policy: `Default Deny`
    - denies any MCP request that does not match an explicit allow policy

Create a PingOne Authorize decision endpoint for this policy tree and use its URL as `AUTHORIZE_DECISION_ENDPOINT`.

## DaVinci Flow Setup

This project expects two DaVinci flows:

1. a user-authentication flow for ChatGPT access to the MCP protected resource
2. a CIBA approval flow for agent-initiated booking approval

### Add the exported flow JSON files to the repo

Store the exported/importable DaVinci flow JSON files in:

- `davinci-flows/MyHotels - ChatGPT User Authentication.json`
- `davinci-flows/MyHotels - CIBA Approval via Magic Link.json`

These files are not used directly by the Node.js runtime. They are kept in the repo so the PingOne and DaVinci configuration is versioned together with the application.

### Import the flows into DaVinci & Create the DaVinci policies

For each flow:

1. Open DaVinci in your PingOne environment.
2. Go to `Flows`.
3. Choose `Import`.
4. Import the JSON file from the repo.
5. Save the imported flow with a clear name.

Always in DaVinci in Applications -> PingOne SSO Connection, create the login (`MyHotels ChatGPT User Authentication`) and the CIBA (`MyHotels CIBA Approval via Magic Link`)PingOne Flow Policies pointing to the imported flows.

The CIBA approval flow triggers the notification email from DaVinci. Create a `General` email template for that notification, and make sure the email body includes the `${magicLink}` parameter so the user can open the approval link.

In PingOne:

1. Open the ChatGPT-facing MCP application.
2. Go to the sign-on / authentication policy area for the application.
3. Select the DaVinci flow policy or authentication flow option.
4. Attach the `MyHotels ChatGPT User Authentication` policy.
5. Confirm that this application is attached to the MCP protected resource only.

1. Open the dedicated CIBA client.
2. Confirm that the `CIBA` grant type is enabled.
3. Open the DaVinci flow policy / CIBA policy configuration for the client.
4. Attach the `MyHotels CIBA Approval via Magic Link` policy.

### Quick mapping summary

- ChatGPT-facing MCP application
  - protected resource: MCP resource
  - audience: `myhotels-hotelmcp`
  - scopes: `my-hotels:mcp:member_rates`, `my-hotels:mcp:book`
  - DaVinci flow: `MyHotels ChatGPT User Authentication`

- MCP token-exchange client
  - protected resource: backend API resource
  - audience requested during exchange: `myhotels-hotelapi`
  - scopes requested during exchange:
    - `my-hotels:api:member_rates` for member-rate hotel search
    - `my-hotels:api:book` for booking quote, creation, and finalization
  - DaVinci flow: none in this project setup

- CIBA client
  - used by MCP for agent-initiated booking approval
  - CIBA scope: `openid my-hotels:api:book`
  - DaVinci flow: `MyHotels CIBA Approval via Magic Link`

- Authorize client
  - used by MCP to call the PingOne Authorize decision endpoint
  - grant type: client credentials
  - token endpoint authentication: client secret basic
  - decision response required by the MCP: `decision: "PERMIT"`

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
MCP_MEMBER_RATES_SCOPE=my-hotels:mcp:member_rates
MCP_BOOK_SCOPE=my-hotels:mcp:book
MCP_CLIENT_ID=<pingone-mcp-token-exchange-client-id>
MCP_CLIENT_SECRET=<pingone-mcp-token-exchange-client-secret>

# Backend API token requirements
API_AUDIENCE=myhotels-hotelapi
API_MEMBER_RATES_SCOPE=my-hotels:api:member_rates
API_BOOK_SCOPE=my-hotels:api:book

# PingOne CIBA client used by the MCP server
CIBA_CLIENT_ID=<pingone-ciba-client-id>
CIBA_CLIENT_SECRET=<pingone-ciba-client-secret>

# CIBA scope used by the MCP server
CIBA_SCOPE=openid my-hotels:api:book

# PingOne Authorize PDP used by the MCP server
AUTHORIZE_DECISION_ENDPOINT=https://api.pingone.eu/v1/environments/<environment-id>/decisionEndpoints/<decision-endpoint-id>
AUTHORIZE_CLIENT_ID=<pingone-authorize-client-id>
AUTHORIZE_CLIENT_SECRET=<pingone-authorize-client-secret>
```

How these values are used:

- ChatGPT authenticates to the MCP using the separate ChatGPT connector client attached to the MCP protected resource.
- The ChatGPT-facing MCP token includes the authenticated user's `sub`, `given_name`, and `groups`, plus an `act.sub` value for the ChatGPT connector client ID.
- The MCP forwards the inbound ChatGPT bearer token to PingOne Authorize and does not locally validate that token with JWKS.
- After Authorize returns `PERMIT`, the MCP parses permitted token claims only for demo state such as display name and booking owner matching.
- For protected backend calls, the MCP uses `MCP_CLIENT_ID` and `MCP_CLIENT_SECRET` from the separate MCP token-exchange client.
- That token exchange requests a backend API token for `API_AUDIENCE` and the matching API scope:
  - member-rate search requests `API_MEMBER_RATES_SCOPE`
  - booking quote, creation, and finalization requests `API_BOOK_SCOPE`
- The exchanged backend API token keeps the user `sub` and `groups`, then changes `act.sub` to the MCP token-exchange client ID and nests the ChatGPT connector client ID under `act.act.sub`.
- The backend API validates that exchanged token locally with JWKS.
- The MCP server uses the separate CIBA client to start and poll approval sessions.
- The MCP server uses the separate Authorize client to call the PingOne Authorize PDP for every MCP tool call.
- Each Authorize call includes:
  - `MyHotels.service`: the MCP audience
  - `MyHotels.resource`: the MCP tool name
  - `MyHotels.parameters.*`: the flattened tool arguments, such as `MyHotels.parameters.totalPrice` and `MyHotels.parameters.currency`
  - `MyHotels.bearerToken`: the inbound ChatGPT bearer token, when present

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
http://localhost:3100/widget/myhotels-widget
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

Create a custom ChatGPT connector for the MyHotels MCP server:

1. Open ChatGPT connector settings and create a new app / connector.
2. Set the name, for example `MyHotels`.
3. Use `Server URL` as the connection type.
4. Set the MCP server URL to:

   ```text
   https://<your-public-url>/mcp
   ```

5. Set authentication to `Mixed` so ChatGPT can use public tools without OAuth and request OAuth for protected tools.
6. Open the advanced OAuth settings.
7. Use a user-defined OAuth client.
8. Copy the ChatGPT-generated callback URL and add that exact URL to the redirect URIs of the ChatGPT-facing MCP application in PingOne.
9. In ChatGPT, set the OAuth client ID and client secret from the ChatGPT-facing MCP application.
10. Confirm that ChatGPT discovers the PingOne OAuth endpoints and the MCP protected resource metadata.
11. Select the MCP scopes exposed by the connector, including:

    ```text
    my-hotels:mcp:member_rates
    my-hotels:mcp:book
    ```

12. Accept the custom MCP server warning and create the connector.

After creating the connector, start a ChatGPT conversation with the MyHotels app and connect it when prompted. The first protected action should send the user through the PingOne authentication flow.

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
- the Authorize policy permits the user token for the protected tool being called
- the Authorize policy checks the MCP token audience against `MCP_AUDIENCE`, if audience enforcement is desired
- the ChatGPT connector client is attached to the MCP protected resource, not the API resource
- token exchange is enabled for the separate MCP token-exchange client in PingOne
- the backend-translated token audience matches `API_AUDIENCE`
- the backend-translated token includes the matching API scope for the backend route being called

### Authorize decision issues

Check:

- `AUTHORIZE_DECISION_ENDPOINT`
- `AUTHORIZE_CLIENT_ID`
- `AUTHORIZE_CLIENT_SECRET`
- the decision endpoint returns `decision: "PERMIT"` for allowed operations

### CIBA setup issues

Check:

- the CIBA client is enabled for the CIBA grant
- the DaVinci flow policy is attached
- the CIBA endpoints are correct
- the CIBA scope and identity hint mapping match your PingOne setup
