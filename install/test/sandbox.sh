#!/usr/bin/env bash
# Roda dentro de um container Linux limpo (sem Node). Espera o código do kx
# montado em /src e executa o fluxo completo do instalador como usuário comum.
set -euo pipefail
export HOME=/home/dev
cd "$HOME"

# Projeto de exemplo com um identificador exato que só o BM25 acha.
mkdir -p demo/docs demo/src/resilience && cd demo
git init -q && git config user.email t@t && git config user.name t
printf '# Demo\n\nServiço de pagamentos com retry e circuit breaker.\n' > README.md
printf '# Runbook\n\nQuando o alerta disparar, verifique o disjuntor do gateway.\n' > docs/runbook.md
printf "export const STATE_OPEN = 'circuit-open';\nexport const THRESHOLD = 5;\n" > src/resilience/CircuitBreakerConfig.ts
printf 'API_KEY=segredo\n' > .env
git add -A >/dev/null && git commit -qm init
mkdir -p "$HOME/.claude" "$HOME/.codex"   # simula Claude Code e Codex instalados

echo "=== curl | bash (simulado com cat) ==="
cat /src/install/install.sh | KX_SOURCE_DIR=/src KX_YES=1 bash

echo "=== shell novo ==="
export PATH="$HOME/.local/bin:$PATH"
kx version
kx doctor
kx search "circuit-open" --top 2
echo "=== arquivos gerados ==="
cat .kx.json | head -30
cat .mcp.json
cat .codex/config.toml
test ! -e "$HOME/demo/~" && echo "sem diretório literal ~"
grep -c "segredo" "$HOME/.kx/data/demo.sqlite" >/dev/null 2>&1 && echo "VAZOU .env" || echo ".env fora do índice"

echo "=== MCP E2E ==="
KX_MODELS_DIR="$HOME/.kx/models" "$HOME/.kx/runtime/current/bin/node" /src/install/test/mcp-e2e.mjs "$(pwd -P)"

echo "=== reinstalação idempotente ==="
cat /src/install/install.sh | KX_SOURCE_DIR=/src KX_NO_SETUP=1 bash | grep -E "Node.js privado|kx doctor"

echo "=== uninstall ==="
bash /src/install/install.sh --uninstall
test ! -e "$HOME/.local/bin/kx" && test -d "$HOME/.kx/data" && echo "removido, dados preservados"
echo "SANDBOX_OK"
