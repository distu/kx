#!/usr/bin/env bash
# Sobe o KX Cockpit: garante o daemon kxd de pe e abre o app de menu bar.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KX="$(cd "$SCRIPT_DIR/.." && pwd)"
APP="$KX/cockpit-app/.build/debug/KxCockpit"
NODE="/opt/homebrew/bin/node"

# 1) Daemon kxd (so sobe se ainda nao estiver respondendo)
if ! "$NODE" -e "require('http').get('http://127.0.0.1:7717/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
  echo "iniciando daemon kxd..."
  ( cd "$KX" && "$NODE" --import tsx ./src/index.ts daemon --port 7717 >/tmp/kxd.log 2>&1 & )
  sleep 2
else
  echo "daemon kxd ja esta no ar."
fi

# 2) Build do app (se necessario)
if [ ! -x "$APP" ]; then
  echo "compilando o app..."
  ( cd "$KX/cockpit-app" && swift build )
fi

# 3) App de menu bar
echo "abrindo o Cockpit no menu bar (procure o icone de pilha no topo direito)..."
"$APP" >/tmp/cockpit-app.log 2>&1 &
echo "pronto. PID do app: $!"
