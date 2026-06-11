/**
 * Stateless MCP transport adapter that exposes widget resources and tool calls over Streamable HTTP.
 */
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logError, logInfo } from './logging.js';
import { mountMcpTools, mountWidgetResources } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  publicUrl?: string;
  apiBaseUrl: string;
  authServerUrl: string;
  authIssuer: string;
  authJwksUrl: string;
  tokenEndpoint: string;
  mcpAudience: string;
  mcpMemberRatesScope: string;
  mcpBookScope: string;
  mcpClientId: string;
  mcpClientSecret: string;
  apiAudience: string;
  apiMemberRatesScope: string;
  apiBookScope: string;
}

/** Reads the built widget markup used by the local browser route and MCP resource. */
function readWidgetMarkup(filename: string): string {
  try {
    return readFileSync(join(__dirname, '../widget-ui', filename), 'utf-8');
  } catch {
    return '<!DOCTYPE html><html><body><h1>UI not built yet. Run npm run build:ui</h1></body></html>';
  }
}

/** Loads runtime configuration for the MCP transport server. */
function loadConfig(): Config {
  const mcpPort = process.env.MCP_PORT;
  const apiBaseUrl = process.env.API_BASE_URL;
  const authServerUrl = process.env.AUTH_SERVER_URL;
  const mcpAudience = process.env.MCP_AUDIENCE;
  const mcpMemberRatesScope = process.env.MCP_MEMBER_RATES_SCOPE;
  const mcpBookScope = process.env.MCP_BOOK_SCOPE;
  const mcpClientId = process.env.MCP_CLIENT_ID;
  const mcpClientSecret = process.env.MCP_CLIENT_SECRET;
  const apiAudience = process.env.API_AUDIENCE;
  const apiMemberRatesScope = process.env.API_MEMBER_RATES_SCOPE;
  const apiBookScope = process.env.API_BOOK_SCOPE;

  if (!mcpPort) {
    throw new Error('MCP_PORT environment variable is required');
  }

  if (!apiBaseUrl) {
    throw new Error('API_BASE_URL environment variable is required');
  }

  if (!authServerUrl) {
    throw new Error('AUTH_SERVER_URL environment variable is required');
  }

  if (!mcpAudience) {
    throw new Error('MCP_AUDIENCE environment variable is required');
  }

  if (!mcpMemberRatesScope) {
    throw new Error('MCP_MEMBER_RATES_SCOPE environment variable is required');
  }

  if (!mcpBookScope) {
    throw new Error('MCP_BOOK_SCOPE environment variable is required');
  }

  if (!mcpClientId) {
    throw new Error('MCP_CLIENT_ID environment variable is required');
  }

  if (!mcpClientSecret) {
    throw new Error('MCP_CLIENT_SECRET environment variable is required');
  }

  if (!apiAudience) {
    throw new Error('API_AUDIENCE environment variable is required');
  }

  if (!apiMemberRatesScope) {
    throw new Error('API_MEMBER_RATES_SCOPE environment variable is required');
  }

  if (!apiBookScope) {
    throw new Error('API_BOOK_SCOPE environment variable is required');
  }

  const port = parseInt(mcpPort, 10);
  const publicUrl = process.env.PUBLIC_URL;
  const authIssuer = authServerUrl;
  const authJwksUrl = `${authIssuer}/jwks`;
  const tokenEndpoint = `${authIssuer}/token`;

  if (Number.isNaN(port)) {
    throw new Error('MCP_PORT environment variable must be a valid integer');
  }

  return {
    port,
    publicUrl,
    apiBaseUrl,
    authServerUrl,
    authIssuer,
    authJwksUrl,
    tokenEndpoint,
    mcpAudience,
    mcpMemberRatesScope,
    mcpBookScope,
    mcpClientId,
    mcpClientSecret,
    apiAudience,
    apiMemberRatesScope,
    apiBookScope,
  };
}

export const requestStorage = new AsyncLocalStorage<Request>();

/** Summarizes an inbound JSON-RPC envelope for debug logging. */
function summarizeRpcEnvelope(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "body=<none>";
  }

  const rpc = body as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  };

  const parts = [
    `jsonrpc=${rpc.jsonrpc ?? ""}`,
    `id=${rpc.id ?? ""}`,
    `method=${rpc.method ?? ""}`,
  ];

  if (rpc.params && typeof rpc.params === "object") {
    const toolName = typeof rpc.params.name === "string" ? rpc.params.name : undefined;
    const uri = typeof rpc.params.uri === "string" ? rpc.params.uri : undefined;
    if (toolName) {
      parts.push(`tool=${toolName}`);
    }
    if (uri) {
      parts.push(`uri=${uri}`);
    }
    const paramKeys = Object.keys(rpc.params);
    if (paramKeys.length > 0) {
      parts.push(`paramKeys=${paramKeys.join(",")}`);
    }
  }

  return parts.join(" ");
}

/** Summarizes the outbound JSON-RPC response body for transport-level debug logging. */
function decodeNumericArray(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  if (!value.every((item) => typeof item === "number" && item >= 0 && item <= 255)) {
    return null;
  }

  try {
    return Buffer.from(value).toString("utf8");
  } catch {
    return null;
  }
}

function normalizeJsonForLogging(value: unknown): unknown {
  const decoded = decodeNumericArray(value);
  if (decoded !== null) {
    return {
      decodedText: decoded,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonForLogging(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
      key,
      normalizeJsonForLogging(nestedValue),
    ]);
    return Object.fromEntries(entries);
  }

  return value;
}

function prettyJsonForLog(value: unknown, maxLength = 4000): string {
  const pretty = JSON.stringify(value, null, 2);
  return pretty.length > maxLength ? `${pretty.slice(0, maxLength)}\n...<truncated>` : pretty;
}

function summarizeRpcResponse(bodyText: string): string {
  if (!bodyText) {
    return 'body=<empty>';
  }

  if (bodyText.startsWith("event:") || bodyText.startsWith("data:")) {
    const preview = bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}\n...<truncated>` : bodyText;
    return `stream=\n${preview}`;
  }

  try {
    const parsed = JSON.parse(bodyText) as {
      jsonrpc?: string;
      id?: string | number | null;
      result?: Record<string, unknown>;
      error?: { code?: number; message?: string } | null;
    };

    const parts = [
      `jsonrpc=${parsed.jsonrpc ?? ''}`,
      `id=${parsed.id ?? ''}`,
    ];

    if (parsed.error) {
      parts.push(`errorCode=${parsed.error.code ?? ''}`);
      parts.push(`errorMessage=${parsed.error.message ?? ''}`);
    }

    if (parsed.result && typeof parsed.result === 'object') {
      parts.push(`resultKeys=${Object.keys(parsed.result).join(',')}`);
    }

    const normalized = normalizeJsonForLogging(parsed);
    parts.push(`payload=\n${prettyJsonForLog(normalized)}`);
    return parts.join(' ');
  } catch {
    const preview = bodyText.length > 4000 ? `${bodyText.slice(0, 4000)}\n...<truncated>` : bodyText;
    return `body=\n${preview}`;
  }
}

/** Logs a transport-level view of each inbound MCP request. */
function logMcpRequest(prefix: string, req: Request, sessionId?: string): void {
  const authHeader = req.headers.authorization;
  const hasBearerToken = Boolean(authHeader && authHeader.startsWith("Bearer "));
  logInfo(
    ['mcp', 'request'],
    `${prefix} session=${sessionId ?? ""} path=${req.path} hasBearer=${hasBearerToken} ${summarizeRpcEnvelope(req.body)}`
  );
}

/** Attaches response capture to the MCP transport response so JSON-RPC results are logged too. */
function attachMcpResponseLogging(res: Response): void {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const toBuffer = (chunk: any, encoding?: unknown): Buffer => {
    if (Buffer.isBuffer(chunk)) {
      return chunk;
    }
    if (chunk instanceof Uint8Array) {
      return Buffer.from(chunk);
    }
    if (ArrayBuffer.isView(chunk)) {
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    if (chunk instanceof ArrayBuffer) {
      return Buffer.from(chunk);
    }
    const bufferEncoding = typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined;
    return Buffer.from(String(chunk), bufferEncoding);
  };

  res.write = ((chunk: any, encoding?: any, callback?: any) => {
    if (chunk) {
      chunks.push(toBuffer(chunk, encoding));
    }
    return originalWrite(chunk, encoding, callback);
  }) as typeof res.write;

  res.end = ((chunk?: any, encoding?: any, callback?: any) => {
    if (chunk) {
      chunks.push(toBuffer(chunk, encoding));
    }
    return originalEnd(chunk, encoding, callback);
  }) as typeof res.end;

  res.on('finish', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const contentType = res.getHeader('content-type');
    logInfo(
      ['mcp', 'response'],
      `status=${res.statusCode} contentType=${String(contentType ?? '')} ${summarizeRpcResponse(bodyText)}`
    );
  });
}

/** Builds a fresh MCP server instance for a single stateless POST request. */
function buildProtocolServer(config: Config): McpServer {
  const server = new McpServer({
    name: 'myhotels',
    version: '1.1.0',
  });

  mountWidgetResources(server);
  mountMcpTools(server, config);

  return server;
}

/** Creates the Express application that fronts the MCP transport and widget helpers. */
export function assembleTransportApp(config: Config): express.Application {
  const app = express();

  app.use(express.json());
  app.use('/widget-assets', express.static(join(__dirname, '../../widget-ui/img')));

  app.get('/widget/myhotels-widget', (_req, res) => {
    const html = readWidgetMarkup('myhotels-widget.html');
    res.type('html').send(html);
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    const baseUrl = config.publicUrl || `http://localhost:${config.port}`;
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [config.authServerUrl],
      scopes_supported: [config.mcpMemberRatesScope, config.mcpBookScope],
    });
  });

  const mcpPostHandler = async (req: Request, res: Response) => {
    logMcpRequest("POST", req);
    attachMcpResponseLogging(res);

    const server = buildProtocolServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const closeableServer = server as McpServer & { close?: () => Promise<void> | void };
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      void transport.close();
      void closeableServer.close?.();
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);

    try {
      await requestStorage.run(req, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      cleanup();
      logError(['mcp', 'error'], 'Error handling MCP request', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  };

  app.post('/mcp', mcpPostHandler);

  return app;
}

/** Starts the MCP transport server on the configured port. */
export function launchTransportServer(): void {
  const config = loadConfig();
  const app = assembleTransportApp(config);

  app.listen(config.port, () => {
    logInfo(['server'], `Started on port ${config.port}`);
    logInfo(['server'], `MCP endpoint=http://localhost:${config.port}/mcp`);
  });
}

launchTransportServer();
