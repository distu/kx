# 06 - Descoberta e Estado das Sessoes do Claude Code

O Session Service do daemon transforma os transcripts crus do Claude Code numa lista utilizavel: quem esta rodando agora, titulo, e o comando exato de retomada. Reusa e formaliza o que o `megabrain.ts` ja faz em `detectClaudeSession()`.

Quando o registry local ainda não existe, defina as raízes de descoberta em
`KX_DISCOVERY_ROOTS`, separadas por `:` no macOS/Linux e por `;` no Windows.
Sem essa variável, o daemon procura apenas em `~/Projects` e `~/projects`.

## Onde estao os transcripts

```
~/.claude/projects/<project-slug>/<session-uuid>.jsonl
```

- `<project-slug>`: caminho absoluto do projeto com todo caractere nao-alfanumerico trocado por `-`.
  Ex.: `/absolute/path/to/home/projects/organização/organização-a/git/fase2`
     -> `-path-to-user-projects-organização-organização-a-git-fase2`
- `<session-uuid>`: **e o session id** usado em `claude --resume <uuid>`.
- Cada arquivo `.jsonl` = uma sessao; cada linha = um evento (mensagem, tool use, meta).

Mapeamento inverso (slug -> projeto): o daemon mantem, para cada projeto registrado, o `projectRoot` e computa o slug esperado. Assim liga um `.jsonl` ao projeto certo com certeza, sem heuristica fragil.

---

## Parsing eficiente (nao ler o arquivo inteiro)

Transcripts podem ter MBs. Estrategia:

1. **Cabeca do arquivo** (primeiras N linhas): primeiro evento util -> `startedAt`, `firstPromptExcerpt` (primeiro prompt do usuario, resumido).
2. **Cauda do arquivo** (ultimas linhas via leitura reversa/seek): ultimo evento -> confirma `lastActivityAt` e se o ultimo evento foi do assistant (idle) ou uma pergunta pendente.
3. **`mtime` do arquivo**: sinal barato de "quando mexeu pela ultima vez".
4. **Titulo**: se houve `/rename`, o titulo aparece num evento de meta/comando (ex.: `<command-name>/rename` com args). O parser procura o ultimo rename; se nao houver, usa `firstPromptExcerpt` resumido.

Nunca carregar o `.jsonl` inteiro em memoria para listar. Leitura integral so sob demanda (abrir detalhe de uma sessao).

---

## Heuristica de estado (`state`)

Determinar "esta rodando agora" e o ponto mais delicado - e a fonte de erro mais comum. Regra em camadas, do sinal mais forte ao mais fraco:

| Estado | Como determinar |
|--------|-----------------|
| `running` | Ha um processo `claude` vivo cujo cwd/projeto casa com o slug **E** o `.jsonl` teve escrita nos ultimos ~90s |
| `idle` | `.jsonl` existe, ultimo evento e do assistant (aguardando input), sem escrita recente mas processo ainda vivo |
| `ended` | Nenhum processo `claude` correspondente vivo; `.jsonl` sem escrita ha muito tempo |
| `unknown` | Nao foi possivel determinar com confianca (ex.: nao da pra casar processo com projeto) |

Deteccao de processo: varrer processos `claude` (via `ps`/`libproc`) e tentar casar pelo diretorio de trabalho ou por argumentos. Onde nao houver certeza, **`unknown` e a resposta honesta** - a UI mostra "?" em vez de mentir "rodando".

Observacao importante (herdada do `detectClaudeSession()`): com **varias sessoes no mesmo projeto** ao mesmo tempo, casar `.jsonl` <-> processo pela pasta e ambiguo. Por isso:
- O `sessao` explicito (passado pela tool/daemon quando a atividade foi criada) sempre vence a inferencia.
- O daemon usa `mtime` + evento mais recente para desempatar, mas nunca afirma "esta e a sessao" quando ha empate real; marca `unknown`.

---

## Detecao de eventos em tempo real (watcher)

- FSEvents / `DispatchSource` (no lado Swift) e `chokidar` (no lado daemon) observam `~/.claude/projects/`.
- Novo `.jsonl` -> emite `session.active`.
- Escrita em `.jsonl` existente -> atualiza `lastActivityAt`, pode disparar `session.active` (transicao unknown/idle -> running).
- Sem escrita por X (config, ex.: 5min) + processo morto -> `session.ended` (dispara alarme se configurado).

---

## Comando de retomada

Montado pelo daemon e entregue pronto ao cliente:

```
claude --resume <session-uuid> --dangerously-skip-permissions
```

- O flag `--dangerously-skip-permissions` e configuravel por projeto no Settings (default: ligado, conforme pedido; mas explicitamente exposto porque e uma escolha de seguranca do usuario).
- O `cwd` correto (o `projectRoot`) tambem e entregue, para que o terminal seja aberto **no diretorio do projeto** antes de rodar o comando (doc 07). Retomar no diretorio errado quebra o contexto.

Variacoes previstas (Settings):
- Com/sem `--dangerously-skip-permissions`.
- Prefixo de `cd <projectRoot> && ` embutido ou nao.
- Wrapper opcional (ex.: abrir dentro de `zsh -ic` para carregar aliases/VPN, padrao usado no ambiente organização).

---

## Associacao sessao <-> atividade

- Uma atividade lista `sessoes_claude: [uuid...]`. O daemon casa cada uuid com o indice de sessoes.
- Sessao ativa **sem** atividade associada aparece em `/sessions/orphans`. A UI oferece (sem forcar): "associar a uma atividade existente" ou "criar atividade a partir desta sessao" (pre-preenche titulo com o `title`/primeiro prompt).
- Ao criar/atualizar atividade pelo Cockpit durante uma sessao, o daemon injeta o `sessionId` atual em `sessoes_claude` reusando a logica do `updateActivity()` (nao duplica uuid).

---

## Casos de borda tratados

| Caso | Tratamento |
|------|-----------|
| Duas sessoes no mesmo projeto | Ambas listadas; estado `unknown` quando nao da pra desempatar; `sessao` explicito vence |
| `.jsonl` corrompido/parcial | Parser tolerante: ignora linha invalida, usa o que conseguir; nunca derruba a listagem |
| Projeto do transcript nao registrado no Cockpit | Sessao aparece so em `/sessions/orphans` global; sugere registrar o projeto |
| Sessao renomeada varias vezes | Usa o ultimo `/rename` |
| Transcript sem nenhum prompt de usuario ainda | `title` = "(sessao nova)"; `state` provavelmente `running` |
