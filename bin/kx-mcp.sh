#!/usr/bin/env bash
# Wrapper kx MCP - resolve ABI mismatch better-sqlite3 quando Node muda.
# - Marker file evita rebuild redundante (rebuild so quando ABI muda).
# - Logs em ~/.kx/logs/kx-mcp.log (nao silencia falhas).
# - Falha alta + visivel se rebuild quebrar (em vez de subir MCP zumbi).

set -euo pipefail

KX_DIR="$HOME/.kx"
LOG_DIR="$KX_DIR/logs"
LOG_FILE="$LOG_DIR/kx-mcp.log"
MARKER="$KX_DIR/.abi-marker"
mkdir -p "$LOG_DIR"

log() { printf '[%s] [kx-mcp] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG_FILE" >&2; }

# Node FIXO em Homebrew. Nao usar fnm/nvm - muda por shell e causa ABI mismatch.
# Se brew upgrade Node, wrapper detecta via marker e rebuilda automaticamente.
NODE_BIN="/opt/homebrew/bin/node"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ ! -x "$NODE_BIN" ]; then
  log "ERRO: node Homebrew nao encontrado em $NODE_BIN. Instale: brew install node"
  exit 1
fi

NODE_ABI="$("$NODE_BIN" -p 'process.versions.modules')"
NODE_VER="$("$NODE_BIN" -v)"
CURRENT_KEY="abi=${NODE_ABI} ver=${NODE_VER}"

needs_rebuild=0
if [ ! -f "$MARKER" ]; then
  needs_rebuild=1
  log "marker ausente, validando ABI ($CURRENT_KEY)"
elif [ "$(cat "$MARKER" 2>/dev/null)" != "$CURRENT_KEY" ]; then
  needs_rebuild=1
  log "node mudou: $(cat "$MARKER") -> $CURRENT_KEY"
fi

# Health-check REAL: o addon nativo do better-sqlite3 so carrega no construtor
# (new Database), nao no require. Um "require" sozinho da falso-positivo e mascara
# ABI mismatch. Instanciar um DB em memoria forca a carga do .node e expoe o erro.
HEALTHCHECK="new (require('$KX_DIR/node_modules/better-sqlite3'))(':memory:').close()"
if [ "$needs_rebuild" = 0 ]; then
  if ! "$NODE_BIN" -e "$HEALTHCHECK" 2>/dev/null; then
    log "marker bate mas carga do binario nativo falhou, forcando rebuild"
    needs_rebuild=1
  fi
fi

if [ "$needs_rebuild" = 1 ]; then
  log "rodando npm rebuild better-sqlite3 ($CURRENT_KEY)"
  if (cd "$KX_DIR" && npm rebuild better-sqlite3 >>"$LOG_FILE" 2>&1); then
    if "$NODE_BIN" -e "$HEALTHCHECK" 2>>"$LOG_FILE"; then
      echo "$CURRENT_KEY" > "$MARKER"
      log "rebuild ok, marker atualizado"
    else
      log "ERRO: rebuild concluiu mas require ainda falha. Veja $LOG_FILE"
      exit 1
    fi
  else
    log "ERRO: npm rebuild falhou. Veja $LOG_FILE"
    exit 1
  fi
fi

exec "$NODE_BIN" "$KX_DIR/bin/kx.js" "$@"
