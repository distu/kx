#!/usr/bin/env bash
# Wrapper para Claude Desktop — faz chdir antes de iniciar o MCP server kx.
# Defina KX_DESKTOP_CWD para o workspace desejado; sem isso, usa o diretório atual.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${KX_NODE_BIN:-$(command -v node)}"

cd "${KX_DESKTOP_CWD:-$PWD}"
exec "$NODE_BIN" "$KX_DIR/bin/kx.js" mcp "$@"
