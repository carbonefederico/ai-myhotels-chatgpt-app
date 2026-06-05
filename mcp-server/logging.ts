/**
 * Shared MCP-side logging helpers with consistent timestamps and bracketed scopes.
 */

function timestamp(): string {
  return new Date().toISOString();
}

function formatScopes(scopes: string[]): string {
  return scopes.map((scope) => `[${scope}]`).join("");
}

export function logInfo(scopes: string[], message: string): void {
  console.log(`${timestamp()} ${formatScopes(scopes)} ${message}`);
}

export function logError(scopes: string[], message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`${timestamp()} ${formatScopes(scopes)} ${message}`);
    return;
  }

  console.error(`${timestamp()} ${formatScopes(scopes)} ${message}`, error);
}

