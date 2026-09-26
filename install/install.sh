#!/usr/bin/env bash
# Instalador do kx (Knowledge indeX) para macOS e Linux.
#
#   curl -fsSL https://distu.dev/kx/install.sh | bash
#
# O que faz, sem sudo e sem tocar no Node do sistema:
#   1. Baixa um Node.js 22 privado para ~/.kx/runtime (SHA-256 verificado).
#   2. Baixa o kx para ~/.kx/app e instala as dependências com esse Node,
#      o que elimina conflito de ABI do better-sqlite3.
#   3. Cria o comando `kx` em ~/.local/bin e ajusta o PATH do shell.
#   4. Roda `kx doctor --warm`, que baixa o modelo e prova a instalação.
#   5. Dentro de um repositório, oferece `kx setup` para configurar o projeto.
#
# Variáveis: KX_HOME, KX_BIN_DIR, KX_REF (tag, branch ou commit), KX_YES=1,
# KX_NO_SETUP=1, KX_NO_MODIFY_PATH=1, KX_SOURCE_DIR (instala de um checkout local).
# Argumentos: --yes, --no-setup, --ref <ref>, --uninstall [--purge].
#
# Todo o script roda dentro de main(): um download interrompido não executa
# um instalador pela metade.

set -euo pipefail

main() {
  KX_REPO="${KX_REPO:-distu/kx}"
  KX_HOME="${KX_HOME:-$HOME/.kx}"
  KX_BIN_DIR="${KX_BIN_DIR:-$HOME/.local/bin}"
  KX_REF="${KX_REF:-}"
  KX_NODE_MAJOR=22
  local uninstall=0 purge=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) KX_YES=1 ;;
      --no-setup) KX_NO_SETUP=1 ;;
      --ref) KX_REF="${2:?--ref exige um valor}"; shift ;;
      --uninstall) uninstall=1 ;;
      --purge) purge=1 ;;
      *) die "argumento desconhecido: $1" ;;
    esac
    shift
  done

  setup_colors
  banner

  if [ "$uninstall" = 1 ]; then do_uninstall "$purge"; return; fi

  detect_platform
  require_tools
  guard_dev_install
  mkdir -p "$KX_HOME/logs" "$KX_HOME/models" "$KX_HOME/bin"
  LOG="$KX_HOME/logs/install.log"
  : > "$LOG"

  install_node
  install_app
  install_shim
  ensure_path
  verify
  offer_setup
  outro
}

# ---------- saída ----------

setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
    LIME=$'\033[38;2;214;255;63m'; CYAN=$'\033[38;2;92;225;255m'
    WARM=$'\033[38;2;255;246;230m'; RED=$'\033[38;2;255;90;54m'
  else
    B=''; D=''; R=''; LIME=''; CYAN=''; WARM=''; RED=''
  fi
}

banner() {
  printf '\n'
  printf '  %s%sk%s%sx%s  %sKnowledge indeX%s\n' "$B" "$WARM" "$R$B" "$LIME" "$R" "$B" "$R"
  printf '      %sbusca híbrida local para agentes de IA · instalador%s\n\n' "$D" "$R"
}

# Mostra caminhos sob o HOME como ~/...
pretty() {
  # shellcheck disable=SC2088 # o til é literal, só para exibição
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

ok()   { printf '  %s✔%s %s %s%s%s\n' "$LIME" "$R" "$1" "$D" "${2:-}" "$R"; }
info() { printf '  %s›%s %s\n' "$CYAN" "$R" "$1"; }
warn() { printf '  %s!%s %s\n' "$WARM" "$R" "$1"; }
die()  {
  printf '\n  %s✘ %s%s\n' "$RED" "$1" "$R" >&2
  if [ -n "${LOG:-}" ] && [ -s "$LOG" ]; then
    printf '  %súltimas linhas de %s:%s\n' "$D" "$LOG" "$R" >&2
    tail -n 15 "$LOG" | sed 's/^/    /' >&2
  fi
  exit 1
}

# Executa um passo demorado com cronômetro; saída detalhada vai para o log.
step() {
  local label="$1"; shift
  local start=$SECONDS
  if [ -t 1 ]; then
    "$@" >>"$LOG" 2>&1 &
    local pid=$! i=0
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s %s%ss%s ' "$CYAN" "${frames[i++ % 10]}" "$R" "$label" "$D" "$((SECONDS - start))" "$R"
      sleep 0.1
    done
    printf '\r\033[2K'
    wait "$pid" || die "falhou: $label"
  else
    info "$label..."
    "$@" >>"$LOG" 2>&1 || die "falhou: $label"
  fi
  STEP_SECS=$((SECONDS - start))
}

# ---------- ambiente ----------

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) die "sistema não suportado: $(uname -s). No Windows, use o install.ps1." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "arquitetura não suportada: $(uname -m)" ;;
  esac
  if [ "$OS" = linux ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then
    die "Linux com musl (Alpine) ainda não é suportado: o Node oficial e o sqlite-vec exigem glibc."
  fi
  ok "Plataforma" "$OS-$ARCH"
}

require_tools() {
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 --connect-timeout 20 "$1" -o "$2"; }
    fetch_text() { curl -fsSL --retry 3 --connect-timeout 20 "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
    fetch_text() { wget -q -O - "$1"; }
  else
    die "é preciso curl ou wget."
  fi
  command -v tar >/dev/null 2>&1 || die "é preciso tar."
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    die "é preciso sha256sum ou shasum para verificar downloads."
  fi
}

# Um ~/.kx que é link simbólico ou checkout Git é uma instalação de
# desenvolvimento: o instalador não escreve por cima dela.
guard_dev_install() {
  if [ -L "$KX_HOME" ] || [ -d "$KX_HOME/.git" ]; then
    die "$KX_HOME é um checkout de desenvolvimento. Use KX_HOME=<outro diretório> para instalar ao lado."
  fi
}

# ---------- Node privado ----------

install_node() {
  local index version
  index="$(fetch_text https://nodejs.org/dist/index.json)" || die "não foi possível consultar nodejs.org"
  version="$(printf '%s' "$index" | grep -o "\"version\":\"v${KX_NODE_MAJOR}\.[0-9]*\.[0-9]*\"" | head -n1 | cut -d'"' -f4)"
  [ -n "$version" ] || die "nenhuma versão do Node $KX_NODE_MAJOR encontrada"

  local dir="$KX_HOME/runtime/node-$version"
  if [ -x "$dir/bin/node" ]; then
    ok "Node.js privado" "$version · já instalado"
  else
    local name="node-$version-$OS-$ARCH.tar.gz"
    local tmp; tmp="$(mktemp -d)"
    step "Baixando Node.js $version" fetch "https://nodejs.org/dist/$version/$name" "$tmp/$name"
    fetch "https://nodejs.org/dist/$version/SHASUMS256.txt" "$tmp/SHASUMS256.txt" || die "sem SHASUMS256.txt"
    local expected actual
    expected="$(grep " $name\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
    actual="$(sha256 "$tmp/$name")"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "SHA-256 do Node não confere (esperado $expected, obtido $actual)"
    mkdir -p "$dir"
    tar -xzf "$tmp/$name" -C "$dir" --strip-components=1
    rm -rf "$tmp"
    ok "Node.js privado" "$version · SHA-256 verificado · ${STEP_SECS}s"
  fi
  ln -sfn "node-$version" "$KX_HOME/runtime/current"
  NODE="$KX_HOME/runtime/current/bin/node"
  NPM="$KX_HOME/runtime/current/bin/npm"
}

# ---------- app ----------

resolve_ref() {
  if [ -n "$KX_REF" ]; then return; fi
  local latest
  latest="$(fetch_text "https://api.github.com/repos/$KX_REPO/releases/latest" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  KX_REF="${latest:-main}"
}

install_app() {
  local stage="$KX_HOME/app.new"
  rm -rf "$stage"; mkdir -p "$stage"

  if [ -n "${KX_SOURCE_DIR:-}" ]; then
    (cd "$KX_SOURCE_DIR" && tar --exclude=./node_modules --exclude=./.git -cf - .) | tar -xf - -C "$stage"
    KX_REF="local:$KX_SOURCE_DIR"
  else
    resolve_ref
    local tgz; tgz="$(mktemp)"
    step "Baixando kx ($KX_REF)" fetch "https://codeload.github.com/$KX_REPO/tar.gz/$KX_REF" "$tgz"
    tar -xzf "$tgz" -C "$stage" --strip-components=1
    rm -f "$tgz"
  fi
  [ -f "$stage/bin/kx.js" ] || die "pacote do kx inválido (bin/kx.js ausente)"

  step "Instalando dependências" env PATH="$(dirname "$NODE"):$PATH" \
    "$NPM" ci --omit=dev --no-audit --no-fund --prefix "$stage"
  printf '%s\n' "$KX_REF" > "$stage/.kx-ref"

  rm -rf "$KX_HOME/app.old"
  [ -d "$KX_HOME/app" ] && mv "$KX_HOME/app" "$KX_HOME/app.old"
  mv "$stage" "$KX_HOME/app"
  rm -rf "$KX_HOME/app.old"
  local version; version="$("$NODE" -p "require('$KX_HOME/app/package.json').version")"
  ok "kx $version" "$KX_REF · ${STEP_SECS}s"
}

install_shim() {
  local shim="$KX_HOME/bin/kx"
  cat > "$shim" <<EOF
#!/bin/sh
# Gerado pelo instalador do kx. Usa o Node privado para evitar conflito de ABI.
KX_NODE="$KX_HOME/runtime/current/bin/node" KX_MODELS_DIR="\${KX_MODELS_DIR:-$KX_HOME/models}" exec "$KX_HOME/runtime/current/bin/node" "$KX_HOME/app/bin/kx.js" "\$@"
EOF
  chmod +x "$shim"
  mkdir -p "$KX_BIN_DIR"
  local link="$KX_BIN_DIR/kx"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "$link já existe e não é do instalador; mantido. Use $shim diretamente."
  else
    ln -sfn "$shim" "$link"
    ok "Comando kx" "$(pretty "$link")"
  fi
  KX_CMD="$shim"
}

ensure_path() {
  case ":$PATH:" in *":$KX_BIN_DIR:"*) return ;; esac
  if [ -n "${KX_NO_MODIFY_PATH:-}" ]; then
    warn "Adicione $KX_BIN_DIR ao PATH para usar o comando kx."
    return
  fi
  local rc line
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ "${rc##*.}" = fish ]; then line="fish_add_path $KX_BIN_DIR"; else line="export PATH=\"$KX_BIN_DIR:\$PATH\""; fi
  mkdir -p "$(dirname "$rc")"
  if ! grep -qsF "$line" "$rc"; then
    printf '\n# kx\n%s\n' "$line" >> "$rc"
  fi
  PATH_HINT="$rc"
  ok "PATH" "$(pretty "$KX_BIN_DIR") adicionado em $(pretty "$rc")"
}

verify() {
  step "Verificando instalação e baixando o modelo (~23 MB)" "$KX_CMD" doctor --warm
  ok "kx doctor" "SQLite, sqlite-vec e embedding testados · ${STEP_SECS}s"
}

# ---------- configuração do projeto ----------

offer_setup() {
  [ -n "${KX_NO_SETUP:-}" ] && return
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$root" ]; then
    SETUP_HINT=1
    return
  fi
  printf '\n'
  if [ -n "${KX_YES:-}" ]; then
    "$KX_CMD" setup --yes --project-root "$root" || warn "kx setup terminou com erro"
  elif (exec </dev/tty) 2>/dev/null; then
    local answer
    printf '  %s?%s Configurar %s%s%s agora (índice + Claude Code/Codex/Cursor)? %s(S/n)%s ' \
      "$CYAN" "$R" "$B" "$root" "$R" "$D" "$R"
    read -r answer </dev/tty || answer=n
    case "$answer" in
      ''|s|S|sim|y|Y|yes)
        "$KX_CMD" setup --project-root "$root" </dev/tty || warn "kx setup terminou com erro"
        ;;
      *) SETUP_HINT=1 ;;
    esac
  else
    SETUP_HINT=1
  fi
}

outro() {
  printf '\n  %sPronto.%s kx instalado em %s\n' "$B" "$R" "$(pretty "$KX_HOME")"
  if [ -n "${PATH_HINT:-}" ]; then
    printf '  %sAbra um novo terminal ou rode:%s source %s\n' "$D" "$R" "$(pretty "$PATH_HINT")"
  fi
  if [ -n "${SETUP_HINT:-}" ]; then
    printf '  %sNa raiz de um projeto:%s kx setup\n' "$D" "$R"
  fi
  printf '  %sDiagnóstico:%s kx doctor   %sRemover:%s curl -fsSL https://distu.dev/kx/install.sh | bash -s -- --uninstall\n\n' \
    "$D" "$R" "$D" "$R"
}

do_uninstall() {
  local purge="$1"
  [ -L "$KX_HOME" ] || [ -d "$KX_HOME/.git" ] && die "$KX_HOME é um checkout de desenvolvimento; nada foi removido."
  rm -rf "${KX_HOME:?}/app" "${KX_HOME:?}/app.new" "${KX_HOME:?}/app.old" "${KX_HOME:?}/runtime" "${KX_HOME:?}/bin" "${KX_HOME:?}/models"
  if [ -L "$KX_BIN_DIR/kx" ]; then rm -f "$KX_BIN_DIR/kx"; fi
  ok "kx removido" "app, runtime, modelo e comando"
  if [ "$purge" = 1 ]; then
    rm -rf "$KX_HOME"
    ok "Dados removidos" "índices em $(pretty "$KX_HOME")/data"
  else
    info "Índices preservados em $(pretty "$KX_HOME")/data (use --purge para apagar)."
  fi
  info "A linha '# kx' no arquivo do shell pode ser removida à mão."
  printf '\n'
}

main "$@"
