# 01 - Pesquisa de Mercado

Levantamento do estado da arte (2026) de tres frentes: gerenciadores de sessao de coding agents, menu bar apps de referencia de UX, e integracao com terminal/DevOps. Objetivo: nao reinventar a roda e identificar o gap real que o Cockpit ocupa.

> Nota de metodo: os projetos abaixo foram identificados via busca web. Popularidade (estrelas) e um indicador de maturidade, nao de qualidade. Antes de copiar qualquer arquitetura, validar o repo diretamente.

---

## 1. Gerenciadores de sessao do Claude Code / coding agents

| Projeto | Plataforma | O que faz | O que roubar |
|---------|-----------|-----------|--------------|
| **ccmanager** | CLI / TUI | Gerencia multiplas sessoes do Claude Code no terminal | A logica de **descoberta e listagem de sessoes** a partir dos transcripts; a heuristica de "qual sessao esta ativa" |
| **ClaudeSessionHub** | macOS nativo (Swift) | Dashboard local de sessoes | Prova que SwiftUI nativo da conta do recado; padroes de leitura de `~/.claude/projects` |
| **Aeroric** | Desktop (Electron) | Multi-projeto + integracao Git | Conceito de **multi-projeto com abas** e cruzamento com Git - o mais proximo do Cockpit conceitualmente |
| **Crystal / claude-squad** | Desktop / TUI | Rodar varias sessoes Claude Code em paralelo | Gestao de concorrencia de sessoes; nomeacao/rotulagem |
| **ccusage / ccflare** | CLI | Metricas de uso/custo das sessoes | Ideia de badge/metrica agregada (para o badge no icone da menu bar) |
| **vibe-kanban / Conductor** | Web / Desktop | Kanban de tarefas de agentes | Modelo mental de "tarefa <-> execucao de agente" |

**Como essas ferramentas descobrem sessoes** (confirmado como padrao comum):
- Leem `~/.claude/projects/<project-slug>/<uuid>.jsonl`.
- O nome do arquivo (`<uuid>`) e o **session id** usado em `claude --resume <uuid>`.
- O `<project-slug>` e o caminho absoluto do projeto com todo caractere nao-alfanumerico trocado por `-`.
- Cada linha do `.jsonl` e um evento (mensagem user/assistant, tool use, etc.). Da para extrair titulo, primeiro prompt, timestamps e ultimo estado lendo so o inicio e o fim do arquivo.
- "Sessao ativa" = arquivo `.jsonl` com `mtime` mais recente / sendo escrito agora. (E exatamente o que o `megabrain.ts` ja faz em `detectClaudeSession()`.)

---

## 2. Menu bar apps de referencia (UX/design)

| App | Por que e referencia |
|-----|----------------------|
| **FineTune** | Padrao-ouro de popover translucido elegante no menu bar: vibrancy, hierarquia, densidade sem poluicao. Referencia visual direta. |
| **Later** | Padrao de "quick-access": restaurar contexto/estado com um clique. Exatamente a metafora do Cockpit ("restaurar sessao"). |
| **Raycast** | Padrao de **hotkey letter-based** e navegacao 100% por teclado. O Cockpit adota a mesma linguagem de atalhos. |
| **claude-status-bar** | Menu bar app do proprio nicho (status de Claude Code). Minimalista - mostra o que da pra fazer com pouco. |

Licoes de UX extraidas:
- Popover com largura fixa (~360-420px) e altura limitada com scroll interno por secao.
- Vibrancy do material do sistema (nao um cinza chapado) - adapta a light/dark automaticamente.
- Acao primaria por hover + atalho; menu de contexto para o resto.
- Header fixo (abas + busca) que nao rola; corpo rolavel.

---

## 3. Integracao com terminal e DevOps

| Achado | Detalhe |
|--------|---------|
| **um produto de referência** | Projeto novo que ja integra Warp + MRs do GitLab. Bom benchmark de **arquitetura de correlacao** (branch -> MR). Mostra que a correlacao em tempo real e viavel. |
| **Warp - abertura programatica** | Warp nao expoe de forma trivial um "abrir aba com comando X" universal. Caminhos: URI scheme `warp://` (limitado), Launch Configurations (YAML em `~/.warp/launch_configurations/`), ou `open -a Warp`. **Fallback robusto: AppleScript no iTerm2/Terminal.app**, que tem automacao rica e estavel. Detalhes no doc 07. |
| **Foco de janela existente** | AppleScript + `NSWorkspace`/window management para trazer ao foco uma janela que ja roda a sessao. |
| **Git -> MR -> Work item** | Padrao mais simples e usar as **CLIs** (`glab mr list`, `az boards work-item show`) em vez de bater na API REST crua - reusa auth ja configurada, menos codigo. API REST fica como fallback. |

---

## 4. Gaps / oportunidade (o diferencial do Cockpit)

Nenhuma ferramenta encontrada combina, num unico produto:

1. **Menu bar nativo macOS** + **abas por projeto com isolamento forte** (a maioria e single-project ou mistura tudo).
2. **Lista de atividades com estado visual** (em andamento / pendente / bloqueada / concluida) vinda de uma fonte de verdade propria (o KX activity manager), nao so "lista de sessoes cruas".
3. **Salto para a sessao no terminal preferido** com fallback em cadeia (Warp -> iTerm -> Terminal) + hotkey letter-based.
4. **Correlacao em tempo real, por atividade**, entre: sessao Claude Code, branch(es), MR(s) do GitLab com estado de review, e item(ns) do Azure DevOps. Isso e o coracao do diferencial e nao existe pronto.
5. **Notificacoes/alarme** ancorados em eventos reais (sessao terminou, MR mudou de estado).
6. **Escrita segura de volta** no KX activity manager (avanco/conclusao) reusando a mesma logica das tools MCP.

Conclusao: o Cockpit nao compete com os gerenciadores de sessao genericos. Ele e a camada de **comando e controle pessoal** sobre um sistema (kx/KX activity manager) que ja tem modelo de dados de atividade e isolamento por projeto - algo que nenhum concorrente tem de fabrica.

---

## 5. Referencias

As URLs completas, versoes e trechos de codigo coletados na pesquisa estao consolidados nos artefatos de pesquisa gerados durante o design (scratchpad da sessao). Os projetos-chave a revisitar antes de implementar cada modulo:

- Descoberta de sessoes: `ccmanager`, `ClaudeSessionHub`.
- Correlacao terminal+Git: `produto de referência`.
- UX de popover: `FineTune`, `Later`.
- Linguagem de atalhos: `Raycast`.
