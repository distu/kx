# 11 - Riscos e Questoes Abertas

Honestidade > otimismo. Aqui estao os pontos que ainda dependem de decisao ou validacao na maquina antes de virar codigo. Nenhum e bloqueante para comecar a Fase 0, mas alguns mudam detalhes de fases posteriores.

## Riscos tecnicos

| # | Risco | Impacto | Mitigacao |
|---|-------|---------|-----------|
| R1 | **Automacao do Warp e instavel entre versoes** | Acao primaria (abrir sessao) pode falhar no terminal preferido | Warp e best-effort; iTerm2/Terminal como fallback estavel garantido (doc 07); Settings permite testar e escolher metodo |
| R2 | **Deteccao de "sessao rodando agora" e ambigua** com varias sessoes no mesmo projeto | Estado errado gera acao errada (abrir duplicado, focar janela errada) | Estado `unknown` honesto; `sessao` explicito vence; nunca afirmar em empate (doc 06) |
| R3 | **Formato do `.jsonl` do Claude Code pode mudar** entre versoes da CLI | Parser de sessao quebra | Parser tolerante (ignora linha invalida); depender so de `mtime` + nome do arquivo (uuid) como contrato minimo estavel |
| R4 | **`megabrain.ts` esta em branch `feat/megabrain-tools`, com WIP na `main`** | Daemon reusa codigo que ainda nao esta consolidado | Alinhar em qual branch o daemon consome; possivel merge de `feat/megabrain-tools` antes da Fase 0 |
| R5 | **Permissao de Automacao (TCC)** para AppleScript pode ser negada | "Focar/abrir terminal" nao funciona | Botao "testar terminal" que forca o prompt e diagnostica; fallback "copiar comando" sempre disponivel |
| R6 | **VPN necessaria para correlacao interna** (Azure/GitLab do organização) | Fase 4 degradada fora da VPN | UX degradada honesta ja especificada; correlacao e opcional, atividade nunca some |
| R7 | **`MenuBarExtra` tem limitacoes** de tamanho/foco/dismiss | UX do painel apertada | Plano B: host AppKit (`NSStatusItem`+`NSPopover`) reusando as Views (doc 09) |
| R8 | **Latencia de `glab`/`az` CLI** (subprocesso por consulta) | Correlacao lenta com muitas atividades | Cache com TTL + refresh assincrono nao-bloqueante; considerar API REST em lote onde a CLI for gargalo |

## Questoes abertas (precisam de decisao do a pessoa desenvolvedora)

| # | Questao | Opcoes | Recomendacao inicial |
|---|---------|--------|----------------------|
| Q1 | Framework HTTP do daemon | Fastify vs `node:http` puro | `node:http` puro (dependencia zero, contrato simples) - reavaliar se crescer |
| Q2 | Descoberta de projetos: registro manual vs auto-scan | manual / auto-sugerido / hibrido | Hibrido: registro em `projects.json` + auto-descoberta que so sugere |
| Q3 | Skip-permissions ligado por default no comando de retomada | ligado / desligado | Ligado (conforme pedido), mas exposto e por-projeto no Settings |
| Q4 | Onde guardar tokens do Cockpit | Keychain vs reusar `glab`/`az` login | Reusar CLI login quando possivel; Keychain para o resto; nunca em arquivo versionado |
| Q5 | Badge do icone: o que contar | ativas / bloqueadas / sessoes running | Config; default = ativas + destaque se ha bloqueadas |
| Q6 | Campo `azure_items` no frontmatter | adicionar agora vs inferir por branch/MR | Adicionar campo opcional; inferencia como conveniencia marcada "inferido" |
| Q7 | Nome/identidade visual do produto | "KX Cockpit" vs outro | "KX Cockpit" (usado nesta spec) - confirmar |
| Q8 | Escopo cross-projeto de sessoes orfas | mostrar global vs so por aba | Global em `/sessions/orphans` (util), mas conteudo sempre rotulado por projeto |

## Validacoes a fazer na maquina antes de codar (nao presuma)

1. **Suporte real de automacao do Warp** na versao instalada (URI/launch config/executar comando). Testar os tres metodos.
2. **Formato atual dos eventos `.jsonl`** de uma sessao real (onde aparece o `/rename`, primeiro prompt, timestamps).
3. **Estado do `megabrain.ts`** entre `main` e `feat/megabrain-tools` (R4) - confirmar as assinaturas que o daemon vai importar.
4. **Como casar processo `claude` <-> projeto** de forma confiavel (args? cwd via `libproc`?) para a heuristica de `running`.
5. **Auth pronta de `glab` e `az`** na maquina para os ambientes alvo (organização usa org/grupo especificos).
6. **Comportamento do `MenuBarExtra .window`** no macOS instalado (foco de teclado, dismiss ao abrir Settings).

## Fora de escopo (explicito)

- Multi-usuario / sincronizacao em nuvem.
- Cross-platform (Windows/Linux).
- Edicao de codigo / diff viewer.
- Kanban colaborativo.
- Escrita em Azure/GitLab (o Cockpit le correlacao; nao move card nem aprova MR - por ora).
