import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function optionalInt(name) {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid integer`);
  }
  return parsed;
}

function buildBasicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function createBindingMessage() {
  return randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function buildSampleTransaction() {
  return {
    hotelName: 'Maison Vendome',
    checkInDate: '2026-06-15',
    nights: 2,
    amount: 498.0,
    currency: 'EUR',
  };
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function decodeJwtClaims(token) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function printTokenClaims(label, token) {
  const claims = decodeJwtClaims(token);
  if (!claims) {
    console.log(`\n${label} claims: token is not a readable JWT`);
    return;
  }

  console.log(`\n${label} claims:`);
  console.log(JSON.stringify(claims, null, 2));
}

async function promptForLoginHint() {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question('PingOne login_hint (username/email): ');
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error('login_hint is required');
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function initiateCiba(config, loginHint, customParameters) {
  const params = new URLSearchParams({
    scope: config.scope,
    login_hint: loginHint,
    binding_message: config.bindingMessage,
  });

  if (customParameters) {
    for (const [key, value] of Object.entries(customParameters)) {
      params.set(key, value);
    }
  }

  if (config.acrValues) {
    params.set('acr_values', config.acrValues);
  }

  if (config.requestedExpiry !== undefined) {
    params.set('requested_expiry', String(config.requestedExpiry));
  }

  const response = await fetch(config.authorizationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${buildBasicAuth(config.clientId, config.clientSecret)}`,
    },
    body: params.toString(),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `CIBA authorization request failed: ${response.status} ${response.statusText}\n${bodyText}`
    );
  }

  return JSON.parse(bodyText);
}

async function pollToken(config, authReqId) {
  const params = new URLSearchParams({
    grant_type: 'urn:openid:params:grant-type:ciba',
    auth_req_id: authReqId,
  });

  const response = await fetch(config.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${buildBasicAuth(config.clientId, config.clientSecret)}`,
    },
    body: params.toString(),
  });

  const bodyText = await response.text();
  const parsed = bodyText ? JSON.parse(bodyText) : {};

  if (response.ok) {
    return { kind: 'approved', body: parsed };
  }

  if (parsed.error === 'authorization_pending' || parsed.error === 'slow_down') {
    return { kind: 'pending', body: parsed };
  }

  if (parsed.error === 'access_denied') {
    return { kind: 'denied', body: parsed };
  }

  if (parsed.error === 'expired_token' || parsed.error === 'invalid_grant') {
    return { kind: 'expired', body: parsed };
  }

  throw new Error(
    `CIBA token polling failed: ${response.status} ${response.statusText}\n${bodyText}`
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const authServerUrl = required('AUTH_SERVER_URL');
  const config = {
    authorizationEndpoint:
      process.env.CIBA_AUTHORIZATION_ENDPOINT || `${authServerUrl}/cibaAuthorization`,
    tokenEndpoint: process.env.CIBA_TOKEN_ENDPOINT || `${authServerUrl}/token`,
    clientId: required('CIBA_CLIENT_ID'),
    clientSecret: required('CIBA_CLIENT_SECRET'),
    scope: process.env.CIBA_SCOPE || `openid ${process.env.API_SCOPE || process.env.MCP_SCOPE || 'hotels:member_access'}`,
    acrValues: process.env.CIBA_ACR_VALUES,
    requestedExpiry: optionalInt('CIBA_REQUESTED_EXPIRY'),
    bindingMessage: createBindingMessage(),
  };

  const loginHint = process.argv[2] || await promptForLoginHint();
  const transaction = buildSampleTransaction();
  const transactionId = randomUUID();
  const customParameters = {
    transaction_id: transactionId,
    hotel_name: transaction.hotelName,
    check_in_date: transaction.checkInDate,
    nights: String(transaction.nights),
    amount: transaction.amount.toFixed(2),
    currency: transaction.currency,
  };

  console.log('Starting PingOne CIBA flow');
  console.log(`login_hint: ${loginHint}`);
  console.log(`scope: ${config.scope}`);
  console.log(`binding_message: ${config.bindingMessage}`);
  console.log(`authorization endpoint: ${config.authorizationEndpoint}`);
  console.log('custom_parameters:');
  console.log(JSON.stringify(customParameters, null, 2));

  const authorizationResponse = await initiateCiba(config, loginHint, customParameters);
  const intervalSeconds = authorizationResponse.interval ?? 2;

  console.log('\nCIBA authorization started');
  console.log(`auth_req_id: ${authorizationResponse.auth_req_id}`);
  console.log(`expires_in: ${authorizationResponse.expires_in}`);
  console.log(`interval: ${intervalSeconds}`);

  while (true) {
    await sleep(intervalSeconds * 1000);
    const result = await pollToken(config, authorizationResponse.auth_req_id);

    if (result.kind === 'pending') {
      console.log(`pending: ${result.body.error}${result.body.error_description ? ` - ${result.body.error_description}` : ''}`);
      continue;
    }

    if (result.kind === 'denied') {
      console.log(`denied${result.body.error_description ? `: ${result.body.error_description}` : ''}`);
      process.exit(1);
    }

    if (result.kind === 'expired') {
      console.log(`expired${result.body.error_description ? `: ${result.body.error_description}` : ''}`);
      process.exit(1);
    }

    console.log('\nCIBA approved');
    console.log(JSON.stringify(result.body, null, 2));
    printTokenClaims('Access token', result.body.access_token);
    printTokenClaims('ID token', result.body.id_token);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
