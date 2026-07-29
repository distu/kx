# KX Cockpit

> Torre de controle no menu bar do macOS para as atividades do KX activity manager e as sessoes do Claude Code, isolada por projeto, com correlacao em tempo real entre atividade, branch, Merge Request e item do Azure DevOps.

**Status**: Especificacao (design) - implementacao nao iniciada
**Stack alvo**: SwiftUI + AppKit (nativo macOS 14+) no cliente; daemon HTTP local em Node (parte do `kx`) no servidor
**Autor da spec**: gerada a partir de pesquisa de mercado + auditoria do codigo do `kx` + estado da arte de menu bar apps (2026)
**Escopo desta entrega**: spec completa + prototipo visual navegavel (`prototype/index.html`)

---

## O problema em uma frase

Hoje as atividades vivem em arquivos `.vault/megabrain/*.md` (um por projeto, isolados) e as sessoes do Claude Code vivem em `~/.claude/projects/<slug>/<uuid>.jsonl`. Nao existe nenhuma superficie unica onde o a pessoa desenvolvedora veja, de bater o olho, o que esta em andamento, o que esta pendente, e possa saltar de volta para a sessao correta com um comando pronto. O Cockpit e essa superficie.

## O que o Cockpit entrega

1. **Menu bar sempre a mao** - um clique no icone abre o painel translucido (transparencia configuravel).
2. **Abas por projeto, isolamento total** - cada projeto (`fase2`, `project-b`, etc.) e uma aba; dados de um projeto NUNCA cruzam com outro.
3. **Lista de atividades com estado visual** - em andamento, pendente, bloqueada, concluida; com busca, filtro e ordenacao por recencia.
4. **Saltar para a sessao** - ao selecionar uma atividade em andamento, o Cockpit:
   - copia o comando de retomada (`claude --resume <session-id> --dangerously-skip-permissions`), ou
   - abre uma aba nova no terminal (Warp/iTerm/Terminal) ja com o comando, ou
   - da foco a uma janela que ja esta rodando aquela sessao.
5. **Hotkey letter-based** - cada atividade visivel ganha uma letra; apertar a letra salta direto para a sessao (padrao Raycast/Vimium).
6. **Correlacao em tempo real** - cada atividade mostra: branches, MRs abertos no GitLab (com estado de review), e os itens do Azure DevOps associados.
7. **Notificacoes e alarme** - avisa quando uma sessao termina, quando um MR muda de estado, ou por lembrete configuravel.
8. **Configuracao rapida** - painel de settings acessivel por um botao (transparencia, hotkeys, terminal preferido, tokens por projeto, alarmes).

---

## Indice da especificacao

| # | Documento | Conteudo |
|---|-----------|----------|
| 00 | [Visao e objetivos](./00-visao-objetivos.md) | Persona, objetivos mensuraveis, non-goals, principios de design |
| 01 | [Pesquisa de mercado](./01-pesquisa-mercado.md) | Ferramentas similares, o que roubar, o gap/diferencial, referencias |
| 02 | [Arquitetura](./02-arquitetura.md) | Componentes ponta a ponta, diagrama, isolamento, decisoes-chave |
| 03 | [Modelo de dados](./03-modelo-dados.md) | Atividade estendida, correlacao, indice de sessoes, schema, migracao |
| 04 | [Daemon HTTP local (kxd)](./04-daemon-http-api.md) | Contrato REST + SSE, endpoints, payloads, seguranca local |
| 05 | [Integracoes DevOps](./05-integracoes-devops.md) | Azure DevOps + GitLab, tokens por projeto, estado de review |
| 06 | [Descoberta de sessoes](./06-descoberta-sessoes.md) | Parsing dos `.jsonl`, deteccao de sessao ativa, comando de retomada |
| 07 | [Terminal e hotkeys](./07-terminal-launch-hotkeys.md) | Abrir/focar Warp/iTerm/Terminal, letter-hotkeys, clipboard |
| 08 | [UX / UI](./08-ux-ui-spec.md) | Layout, abas, listas, busca/filtro, transparencia, settings, wireframes |
| 09 | [Stack SwiftUI](./09-swiftui-stack.md) | MenuBarExtra, vibrancy, KeyboardShortcuts, notificacoes, distribuicao |
| 10 | [Roadmap por fases](./10-roadmap-fases.md) | Sequencia de entrega, marcos, criterios de pronto |
| 11 | [Riscos e questoes abertas](./11-riscos-questoes-abertas.md) | O que ainda precisa de decisao, riscos tecnicos |

**Prototipo visual**: [`prototype/index.html`](./prototype/index.html) - abra no navegador para ver a interface navegavel (abas, listas, transparencia, settings).

---

## Principios inegociaveis (herdados do ecossistema kx)

1. **Isolamento por projeto e sagrado.** O Cockpit nunca mistura dados de dois projetos. O daemon reusa o mesmo mecanismo do KX activity manager (`.kx.json` + `.vault/` por projeto, `vaultRoot()` que recusa config global, `assertInside()` contra path traversal).
2. **Segredos nunca no Git.** Tokens de Azure/GitLab ficam no Keychain do macOS ou no `.vault/_secrets/` do projeto, nunca versionados.
3. **O `.md` do KX activity manager continua sendo a fonte de verdade.** O daemon le/escreve os mesmos arquivos que as tools MCP; o Cockpit e uma leitura/acao sobre eles, nao um banco paralelo divergente.
4. **Read-heavy, write-safe.** O Cockpit majoritariamente le. Quando escreve (marcar avanco, concluir), usa exatamente as mesmas funcoes do `megabrain.ts` para nao divergir do formato.

---

## Glossario rapido

| Termo | Significado |
|-------|-------------|
| **kx** | Knowledge indeX - MCP server + CLI de RAG local do usuario (`~/path/to/kx`) |
| **KX activity manager** | Modulo do kx que gerencia atividades por projeto em `.vault/megabrain/*.md` |
| **kxd** | (novo) daemon HTTP local do kx que agrega todos os projetos e serve o Cockpit |
| **Cockpit** | O app de menu bar (este produto) |
| **Atividade** | Unidade de trabalho do KX activity manager (id, slug, status, sessoes, branches...) |
| **Sessao** | Uma sessao do Claude Code, identificada pelo UUID do arquivo `.jsonl` |
