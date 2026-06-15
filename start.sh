#!/bin/bash

# MyHotels Local Stack

echo "=========================================="
echo "MyHotels Local Stack"
echo "=========================================="
echo ""

if [ ! -f .env ]; then
  echo "⚠️  No .env file found. Creating from template..."
  echo ""

  read -p "AM_BASE_URL (e.g., https://tenant.forgeblocks.com/am/oauth2): " AM_BASE_URL
  read -p "AUTH_ISSUER (default: same as AUTH_SERVER_URL): " AUTH_ISSUER
  read -p "AUTH_JWKS_URL (optional, Enter to derive from AUTH_ISSUER): " AUTH_JWKS_URL
  read -p "AUTH_AUDIENCE (optional): " AUTH_AUDIENCE
  read -p "MCP_PORT (default 3100): " MCP_PORT
  MCP_PORT=${MCP_PORT:-3100}
  read -p "API_PORT (default 3200): " API_PORT
  API_PORT=${API_PORT:-3200}

  cat > .env << EOF
# MCP Server Configuration
MCP_PORT=$MCP_PORT
PUBLIC_URL=http://localhost:$MCP_PORT

# API Server Configuration
API_PORT=$API_PORT
API_BASE_URL=http://localhost:$API_PORT

# OAuth / Authorization Server
AUTH_SERVER_URL=$AM_BASE_URL
AUTH_ISSUER=${AUTH_ISSUER:-$AM_BASE_URL}
AUTH_JWKS_URL=$AUTH_JWKS_URL
AUTH_AUDIENCE=$AUTH_AUDIENCE
EOF

  echo ""
  echo "✅ Configuration saved to .env"
  echo ""
fi

if [ ! -d "dist/mcp-server" ]; then
  echo "📦 Building server and UI..."
  npm run build
  if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
  fi
  echo ""
fi

set -a
source .env
set +a

echo "🚀 Starting MyHotels MCP + API servers..."
echo ""
echo "Server Configuration:"
echo "  MCP Port: ${MCP_PORT}"
echo "  API Port: ${API_PORT}"
echo "  MCP Endpoint: http://localhost:${MCP_PORT}/mcp"
echo "  Protected Resource Metadata: http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource"
echo "  Backend API Base URL: ${API_BASE_URL}"
echo ""
echo "Tools:"
echo "  ✅ search_hotels (public, no auth)"
echo "  🔒 search_hotels_member_rates (requires ${MCP_MEMBER_RATES_SCOPE})"
echo "  🔒 prepare_booking/finalize_booking (require ${MCP_BOOK_SCOPE})"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

npm start
