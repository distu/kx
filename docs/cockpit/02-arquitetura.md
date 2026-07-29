# 02 - Arquitetura

## Visao de 10.000 pes

O Cockpit e um cliente. A inteligencia mora num **daemon HTTP local novo (`kxd`)**, que passa a fazer parte do projeto `kx`. O daemon e a unica peca que conhece o disco (arquivos do KX activity manager, transcripts do Claude Code) e as APIs externas (Azure/GitLab). O app SwiftUI so consome HTTP + SSE e desenha.

Por que um daemon, e nao o app lendo arquivos direto? Tres razoes decisivas:

1. **O kx hoje e MCP puro via stdio - nao ha servidor.** Um app de menu bar nao pode "chamar uma tool MCP"; precisa de um endpoint. Auditoria do codigo confirmou: nenhum HTTP server existe hoje (`src/mcp-server.ts` usa `StdioServerTransport`).
2. **Isolamento e correlacao sao logica de negocio.** Reimplementar em Swift a resolucao de `.kx.json`, o `vaultRoot()`, o `assertInside()`, o parsing de `.md`, e a correlacao com Azure/GitLab seria duplicar (e divergir de) o que ja existe em TypeScript. O daemon reusa `megabrain.ts`/`config.ts` diretamente.
3. **Uma fonte, varios consumidores.** Amanha um TUI, um Raycast extension ou um webview podem consumir o mesmo `kxd`. O app fica burro e substituivel.

Padrao ja validado no ecossistema do usuario: o `kokoro-tts` roda um daemon HTTP local (`127.0.0.1:7711`) com o modelo em memoria. O `kxd` segue a mesma filosofia.

---

## Diagrama de componentes

```
+------------------------------------------------------------------+
|  macOS - maquina do a pessoa desenvolvedora                                       |
|                                                                  |
|  +--------------------------+        +------------------------+  |
|  |  KX Cockpit        |        |  Terminais             |  |
|  |  (SwiftUI menu bar app)   |        |  Warp / iTerm / Term   |  |
|  |                           |        +-----------^------------+  |
|  |  - Abas por projeto       |                    | AppleScript / |
|  |  - Listas + busca/filtro  |  abre/foca sessao  | URI / open    |
|  |  - Hotkeys letter-based   |--------------------+               |
|  |  - Settings + vibrancy    |                                    |
|  +------------+--------------+                                    |
|               |  HTTP (GET/POST) + SSE (stream de eventos)        |
|               |  http://127.0.0.1:7717                            |
|               v                                                   |
|  +---------------------------------------------------------------+|
|  |  kxd - daemon HTTP local (parte do kx, Node)                  ||
|  |                                                               ||
|  |  Camada API      -> /projects /activities /sessions /events   ||
|  |  Camada dominio  -> reusa megabrain.ts + config.ts            ||
|  |  Registry projetos -> descobre .kx.json de projetos conhecidos||
|  |  Watchers        -> chokidar em .vault/megabrain + ~/.claude  ||
|  |  Integracoes     -> AzureClient + GitLabClient (cache + TTL)  ||
|  |  Cache/estado    -> em memoria + snapshot leve em SQLite      ||
|  +----+---------------------+----------------------+-------------+|
|       | le/escreve          | observa              | consulta     |
|       v                     v                      v              |
|  +----------------+  +------------------+   +------------------+   |
|  | .vault/        |  | ~/.claude/       |   | APIs externas    |   |
|  | megabrain/*.md |  | projects/**/     |   | (via VPN quando  |   |
|  | _index/MOC..   |  |   *.jsonl        |   |  necessario)     |   |
|  | (por projeto)  |  | (transcripts)    |   | Azure DevOps     |   |
|  +----------------+  +------------------+   | GitLab (glab/API)|   |
|                                             +------------------+   |
+------------------------------------------------------------------+
```

---

## Componentes

### A. Cliente: KX Cockpit (SwiftUI)

Responsabilidade unica: apresentar e agir. Detalhado nos docs 08 (UX) e 09 (stack).
- Renderiza abas/listas a partir do JSON do daemon.
- Mantem conexao SSE aberta para atualizacao em tempo real (sem polling agressivo).
- Executa acoes locais que nao cabem ao daemon: copiar pro clipboard, abrir/focar terminal, registrar hotkeys globais, exibir notificacoes.
- Guarda apenas preferencias de UI (transparencia, terminal preferido, atalhos) em `UserDefaults`.

### B. Servidor: kxd (novo modulo do kx)

Sobe como quarto modo do binario `kx` (hoje ha `mcp`, `watch`, `cli`; adiciona-se `daemon`). Um LaunchAgent mantem vivo no login (mesmo padrao do kokoro-tts).

Sub-componentes:

| Sub-componente | Papel |
|----------------|-------|
| **Project Registry** | Mantem a lista de projetos que o Cockpit exibe como abas. Cada projeto = um `.kx.json` conhecido. Ver secao "Descoberta de projetos". |
| **Activity Service** | Le/escreve atividades reusando `megabrain.ts` (add/update/get/status). Nunca reimplementa o formato. |
| **Session Service** | Indexa e observa os `.jsonl` do Claude Code, mapeia sessao -> atividade (doc 06). |
| **Integration Service** | `AzureClient` + `GitLabClient`. Correlaciona branches da atividade com MRs e work items (doc 05). Cache com TTL. |
| **Watchers** | `chokidar` em `.vault/megabrain/` (mudou atividade) e FSEvents em `~/.claude/projects/` (sessao ativa). Emite eventos SSE. |
| **Event Bus / SSE** | Publica eventos (`activity.updated`, `session.active`, `mr.changed`) para o cliente. |

### C. Terminais e APIs externas

- Terminais: alvo de acao (doc 07), nunca dependencia de dados.
- Azure/GitLab: consultados pelo daemon, com auth vinda do Keychain/`.vault/_secrets`, respeitando os tokens **por projeto** (isolamento tambem de credenciais).

---

## Descoberta de projetos (como surgem as abas)

O daemon precisa saber quais projetos existem. Estrategia em camadas, da mais explicita para a mais automatica:

1. **Registro explicito** (fonte de verdade): um arquivo `~/.kx/cockpit/projects.json` lista os projetos que viram abas, com apelido, cor e ordem. Editavel pela UI (Settings).
2. **Auto-descoberta assistida**: o daemon pode varrer raizes conhecidas (ex.: `~/projects`, `~/projects`) atras de `.kx.json` e sugerir adicionar como aba - nunca adiciona sozinho sem confirmacao, para nao poluir.
3. **Deduplicacao por `project` do `.kx.json`**: o campo `project` e a chave estavel; o path pode mudar (worktrees), o nome do projeto nao.

Cada aba resolve seu proprio `.kx.json` -> `projectRoot` -> `.vault/`. O isolamento e garantido pela mesma barreira do KX activity manager: `vaultRoot()` recusa home global e exige `.kx.json`; `assertInside()` impede escapar do `.vault/`.

---

## Fluxo de dados (exemplo: abrir o Cockpit)

```
1. Usuario clica no icone da menu bar
2. Cockpit GET /projects            -> lista de abas (id, nome, cor, contadores)
3. Cockpit GET /projects/fase2/activities?status=active&sort=recent
                                     -> atividades da aba ativa, ja correlacionadas
4. Cockpit abre SSE /events?project=fase2
                                     -> recebe activity.updated / session.active / mr.changed
5. Usuario aperta a letra "a"
6. Cockpit resolve a atividade -> pega session-id + comando de retomada
7. Cockpit executa acao de terminal (doc 07) - SEM ida ao daemon (acao local)
```

Correlacao (MRs/Azure) e resolvida no passo 3 pelo daemon, com cache; o cliente nunca fala com GitLab/Azure diretamente.

---

## Decisoes-chave (estilo ADR resumido)

| ID | Decisao | Alternativa rejeitada | Por que |
|----|---------|----------------------|---------|
| D1 | Daemon HTTP local (`kxd`) como backend | App le arquivos direto | Reuso da logica TS; nao duplicar isolamento/correlacao; um backend, varios clientes |
| D2 | SwiftUI + AppKit nativo no cliente | Tauri/Electron | Pesquisa tecnica: vibrancy real, hotkeys robustos, menor bundle, melhor integracao terminal; produto e so macOS |
| D3 | `.md` do KX activity manager continua fonte de verdade | Banco proprio do Cockpit | Zero divergencia com as tools MCP; um so lugar de escrita |
| D4 | Correlacao Azure/GitLab preferindo CLIs (`az`, `glab`) | So API REST | Reusa auth ja configurada, menos codigo; REST como fallback |
| D5 | SSE para tempo real | Polling curto | Menos CPU/rede, atualizacao imediata; SSE e trivial de consumir em Swift via URLSession |
| D6 | Credenciais no Keychain / `.vault/_secrets` | Config file do Cockpit | Regra petrea: segredo nunca no Git; isolamento de credencial por projeto |
| D7 | Porta local fixa `127.0.0.1:7717`, bind so em loopback | Socket unix | HTTP e mais simples de consumir; loopback evita exposicao de rede. (Porta configuravel.) |

---

## Seguranca local

- Daemon faz bind **somente em `127.0.0.1`** (nunca `0.0.0.0`).
- Token de handshake local opcional (`X-Cockpit-Token`) via `KX_COCKPIT_TOKEN`, para evitar que outro processo local qualquer converse com o daemon.
- Nenhum segredo trafega para o cliente: o Cockpit recebe estado de review ("aprovado", "aguardando"), nunca os tokens de Azure/GitLab.
- Escrita no KX activity manager passa pelas mesmas validacoes de path do `megabrain.ts`.
