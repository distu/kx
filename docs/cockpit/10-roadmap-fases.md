# 10 - Roadmap por Fases

Entrega incremental: cada fase produz algo usavel de verdade. A ordem prioriza o valor central (ver e voltar para a sessao) antes da correlacao DevOps (mais complexa).

## Fase 0 - Fundacao do daemon (kxd)
**Objetivo**: o `kx` passa a servir HTTP local reusando a logica existente.
- Novo modo `kx daemon` (Fastify ou `node:http`), bind `127.0.0.1:7717`.
- `GET /health`, `GET /projects` (registry via `~/.kx/cockpit/projects.json`).
- `GET /projects/:project/activities` lendo `.vault/megabrain/*.md` via `megabrain.ts`.
- Isolamento validado (reusa `vaultRoot()`/`assertInside()`).
- LaunchAgent `dev.example.kxd.plist`.
- **Pronto quando**: `curl` lista atividades de um projeto, e recusa cruzamento entre projetos.

## Fase 1 - Cockpit minimo viavel (ver + copiar)
**Objetivo**: menu bar mostrando atividades e copiando o comando de retomada.
- App SwiftUI `MenuBarExtra .window`, abas por projeto, lista de atividades.
- Busca, filtro por status, ordenacao.
- Vibrancy + slider de transparencia.
- Acao "copiar comando de retomada" (clipboard).
- Consumo de `GET /activities` (polling simples nesta fase).
- **Pronto quando**: abro o menu bar, vejo as atividades de `fase2`, copio o comando e colo no terminal e a sessao volta.

## Fase 2 - Sessoes + saltar para o terminal
**Objetivo**: entender sessoes e abrir/focar terminal.
- Session Service no daemon: indexa `.jsonl`, estado (running/idle/ended/unknown), `resumeCommand`.
- `GET /sessions`, `/sessions/orphans`.
- `TerminalLauncher` no app: Warp -> iTerm -> Terminal; abrir e focar.
- Hotkeys letter-based dentro do painel; `Enter`/setas/`/`/`Esc`.
- **Pronto quando**: aperto a letra e a sessao abre no terminal preferido, no cwd certo; sessao ja aberta ganha foco.

## Fase 3 - Tempo real (SSE) + notificacoes
**Objetivo**: painel vivo, sem refresh manual.
- Event Bus + `GET /events` (SSE) no daemon; watchers `chokidar`/FSEvents.
- `DaemonClient` consumindo SSE; badge no icone (ativas/bloqueadas).
- `UserNotifications`: sessao terminou, lembretes.
- Hotkey global de abrir (KeyboardShortcuts).
- **Pronto quando**: encerro uma sessao e o Cockpit atualiza sozinho + notifica; badge reflete o estado em tempo real.

## Fase 4 - Correlacao DevOps
**Objetivo**: MRs e work items por atividade.
- `GitLabClient` (via `glab`, fallback REST): branch -> MR -> `reviewState`.
- `AzureClient` (via `az`): `azure_items` -> work items.
- Cache com TTL + `mr.changed` no SSE + `refresh-devops`.
- Checagem de VPN para projetos que exigem; UX degradada honesta.
- Campos novos `azure_items`/`repos_slug` (opcionais) no frontmatter.
- **Pronto quando**: cada atividade mostra MRs com estado de review e itens Azure; VPN caida degrada sem quebrar.

## Fase 5 - Escrita e command palette
**Objetivo**: agir sem sair do Cockpit.
- `POST /activities` e `/update` (avanco/bloqueio/conclusao) reusando `megabrain.ts`.
- Command palette (`Cmd+K`).
- Associar sessao orfa a atividade / criar atividade a partir de sessao.
- **Pronto quando**: concluo uma atividade pelo Cockpit e o `.md` + MOC ficam identicos ao que a tool MCP produziria.

## Fase 6 - Polimento e distribuicao
**Objetivo**: produto diario.
- Settings completo (todas as abas do doc 08).
- Assinatura + notarizacao; `LSUIElement`; abrir no login.
- Acessibilidade (reduzir transparencia/movimento), tooltips, estados de erro.
- Telemetria local opcional (contadores no badge, tipo `ccusage`).
- **Pronto quando**: uso todo dia sem cair para o terminal para gerenciar contexto.

---

## Dependencias entre fases

```
F0 (daemon) -> F1 (ver/copiar) -> F2 (sessoes/terminal) -> F3 (tempo real)
                                                    \-> F4 (devops) -> F5 (escrita) -> F6 (polimento)
```

F4 depende de F0 (daemon) e F1 (lista), mas nao de F2/F3 - pode ser paralelizada apos F1 se a prioridade mudar.

## Criterios transversais de "pronto" (toda fase)

- Isolamento por projeto testado (nenhum vazamento cruzado).
- Falha honesta: nenhuma tela mente estado (daemon off, VPN down, token expirado sempre explicitos).
- Nenhum segredo no cliente nem no Git.
- Zero divergencia de formato com as tools MCP quando escreve.
