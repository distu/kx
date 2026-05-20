#!/usr/bin/env bash
# Wrapper para Claude Desktop — faz chdir antes de iniciar MCP server kx.
# Shell CLI nao usa este wrapper (continua chamando kx.js direto).
cd "${KX_DESKTOP_CWD:-/absolute/path/to/home/projects/project-b/workspace/project-b}" || exit 1
exec /opt/homebrew/bin/node /absolute/path/to/home/.kx/bin/kx.js mcp "$@"
