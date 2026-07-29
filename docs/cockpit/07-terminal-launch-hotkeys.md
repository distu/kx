# 07 - Terminal, Retomada e Hotkeys

Como o Cockpit executa a acao primaria - saltar para a sessao - e como o teclado dirige tudo. Estas acoes sao **locais ao cliente Swift** (o daemon so entrega o comando e o cwd; quem abre/foca terminal e o app).

## As tres formas de "voltar para a sessao"

Ao acionar uma atividade/sessao, o Cockpit oferece (config define o default):

1. **Copiar comando** - poe no clipboard (`NSPasteboard`) o comando de retomada pronto:
   ```
   cd <projectRoot> && claude --resume <uuid> --dangerously-skip-permissions
   ```
   Feedback visual "copiado" + notificacao opcional. Sempre disponivel como fallback universal.

2. **Abrir no terminal** - abre uma aba/janela nova no terminal preferido ja executando o comando, no `cwd` certo.

3. **Focar sessao existente** - se ja existe uma janela/aba rodando aquela sessao, traz para frente em vez de abrir outra (evita duplicar sessao).

Regra: o Cockpit tenta **3 (focar)** primeiro se detectar a janela; senao faz **2 (abrir)**; **1 (copiar)** e sempre oferecido e e o fallback quando a automacao de terminal falha.

---

## Cadeia de terminais (preferencia + fallback)

Ordem configuravel; default detecta o que esta instalado:

```
Warp  ->  iTerm2  ->  Terminal.app
```

### Warp

Warp e o preferido do usuario, mas e o mais dificil de automatizar de forma robusta. Estrategias, da mais integrada para a mais simples:

- **Launch Configuration (YAML)**: gerar/atualizar `~/.warp/launch_configurations/cockpit-<uuid>.yaml` descrevendo uma janela com o comando, e abrir via `open "warp://launch/cockpit-<uuid>"` ou o URI equivalente suportado pela versao instalada.
- **URI scheme `warp://`**: abrir Warp em contexto; suporte a "executar comando" varia por versao - validar na maquina.
- **`open -a Warp <projectRoot>`** + colar comando: abre Warp no diretorio; o comando vai para o clipboard e (opcional) e "digitado" via evento de teclado. Menos elegante.

Como o suporte do Warp a automacao muda entre versoes, o **doc trata Warp como best-effort** e garante iTerm/Terminal como caminho estavel. O Settings deixa claro qual metodo de Warp esta ativo e permite testar.

### iTerm2 (fallback rico e estavel)

iTerm2 tem AppleScript de primeira classe. Caminho confiavel:

```applescript
tell application "iTerm2"
  create window with default profile
  tell current session of current window
    write text "cd <projectRoot> && claude --resume <uuid> --dangerously-skip-permissions"
  end tell
  activate
end tell
```

Para **focar** uma sessao existente: iTerm permite iterar janelas/sessoes e inspecionar; o Cockpit marca a janela que abriu (por titulo/uuid) e depois localiza por esse marcador para dar `select` + `activate`.

### Terminal.app (fallback universal)

```applescript
tell application "Terminal"
  do script "cd <projectRoot> && claude --resume <uuid> --dangerously-skip-permissions"
  activate
end tell
```

Menos controle de foco por sessao; suficiente como ultimo recurso.

### Execucao a partir do Swift

- `NSAppleScript` ou `Process` chamando `osascript`.
- `NSWorkspace.shared.open` para URIs (`warp://`, `open -a`).
- `NSPasteboard.general` para o clipboard.
- Permissao de Automacao (Apple Events) e pedida na 1a vez (TCC). O Settings tem um botao "testar terminal" que forca o prompt de permissao de forma controlada e diagnostica se foi negado.

---

## Rastreamento de janelas (para "focar")

Para saber se uma sessao ja tem janela aberta:

- Ao abrir via automacao, o Cockpit registra `{sessionId -> {app, windowId/marker}}` em memoria.
- Ao pedir foco, tenta localizar por esse marcador (AppleScript no iTerm/Terminal; para Warp, por titulo da aba quando disponivel).
- Se nao encontrar (janela fechada, reaberta manualmente), degrada para "abrir novo".
- Heuristica complementar: casar com o estado `running` do Session Service (doc 06) - se o daemon diz que a sessao esta viva, provavelmente ha uma janela; se nao acha, ainda assim oferece abrir.

Honestidade: se nao da pra ter certeza de qual janela e, o Cockpit pergunta ("abrir nova aba?" vs "focar a aba X?") em vez de adivinhar e roubar foco errado.

---

## Hotkeys letter-based (padrao Raycast/Vimium)

Quando o painel esta aberto, cada atividade/sessao visivel recebe uma **letra de atalho** exibida a esquerda (a, s, d, f, ...). Apertar a letra dispara a acao primaria daquela linha (focar/abrir sessao).

- Letras atribuidas por posicao visivel; estaveis enquanto a lista nao rola.
- `Enter` aciona o item selecionado; setas/`Ctrl+n`/`Ctrl+p` navegam; `/` foca a busca; `Esc` fecha.
- `Tab`/`Shift+Tab` ou `Cmd+1..9` trocam de aba (projeto).
- `Cmd+K` abre uma command palette (acoes: copiar comando, concluir atividade, atualizar correlacao, abrir MR no browser...).

### Hotkey global (fora do app)

- Um atalho global (ex.: `Cmd+Shift+Space`, configuravel) abre o painel de qualquer lugar - biblioteca `sindresorhus/KeyboardShortcuts` (SPM), madura e type-safe, com UI de captura de atalho pronta.
- Atalhos globais opcionais por projeto (ex.: `Cmd+Ctrl+2` abre direto na aba `fase2`).
- Opcional: atalho global "voltar a ultima sessao ativa" - salta para a sessao `running` mais recente sem nem abrir o painel.

---

## Configuracoes relevantes (ligadas a este doc)

| Config | Default | Efeito |
|--------|---------|--------|
| Terminal preferido | auto-detect (Warp) | Primeiro da cadeia |
| Metodo Warp | launch-config | launch-config \| uri \| open+paste |
| Acao ao acionar | focar-ou-abrir | focar-ou-abrir \| sempre-abrir \| so-copiar |
| Flag skip-permissions | ligado | Inclui/omite `--dangerously-skip-permissions` |
| Prefixo `cd projectRoot` | ligado | Garante cwd correto |
| Wrapper de shell | nenhum | ex.: `zsh -ic '<cmd>'` para carregar aliases/VPN |
| Hotkey global de abrir | Cmd+Shift+Space | Registro via KeyboardShortcuts |
