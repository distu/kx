# 08 - UX / UI

Interface densa, translucida e dirigida por teclado. Referencias de UX: FineTune (vibrancy/densidade), Later (restaurar contexto), Raycast (teclado/atalhos). O prototipo navegavel esta em [`prototype/index.html`](./prototype/index.html).

## Anatomia do painel

Popover ancorado no icone da menu bar. Largura fixa ~400px, altura maxima ~560px (limite de tela), com scroll interno no corpo.

```
+--------------------------------------------------------------+
|  [*] KX Cockpit              [VPN ok]  [gear] [power]  |  <- barra de status (fixa)
+--------------------------------------------------------------+
|  ( fase2 )  ( project-b )  ( kx )  ( setup.ia )        [ + ]    |  <- abas por projeto (fixa)
+--------------------------------------------------------------+
|  [ buscar atividade...            ]  status: [Em andamento v] |  <- busca + filtro (fixa)
|  ordenar: (recentes) (entrega) (criacao)      3 ativas        |
+--------------------------------------------------------------+
|  CORPO ROLAVEL:                                              |
|                                                              |
|  a | * feature de exemplo - reconciliacao por IP          running    |
|    | pdv-core - Edge Bootstrap - atualizada ha 2h            |
|    | mw:feature/onboard-v4  bff:feat/onboard                 |
|    | MR service-a !123 aprovado - MR service-b !456 aguardando review     |
|    | Azure 12345 (Active)                                     |
|    +---------------------------------------------------------|
|  s | ! Hotfix DLQ Kafka                          bloqueado    |
|    | integracoes - Middleware - atualizada ontem             |
|    | aguardando secret DLQ no Secret Manager                 |
|    +---------------------------------------------------------|
|  d | . PIX QR Display Controls                    idle        |
|    | pdv-core - Frontend - atualizada ha 3d                  |
|                                                              |
+--------------------------------------------------------------+
|  1 sessao ativa sem atividade -> associar          [Cmd+K]   |  <- rodape (fixa)
+--------------------------------------------------------------+
```

### Barra de status (topo)
- Nome do produto + icone.
- Indicadores globais: saude de integracoes/VPN (verde/ambar/vermelho), com tooltip.
- `gear` (Settings), `power` (iniciar/parar daemon, quit).

### Abas por projeto
- Uma pilula por projeto registrado, com a cor do projeto.
- Aba ativa destacada; contador de ativas no canto.
- `+` abre o dialogo de registrar/descobrir projeto.
- Isolamento visivel: trocar de aba troca 100% do corpo; nada de um projeto aparece em outro.

### Busca e filtro
- Campo de busca (foca com `/`): filtra por titulo, modulo, descricao, branch.
- Filtro de status: Em andamento (default) / Pendente / Bloqueado / Concluida / Todas.
- Ordenacao: recentes (default) / por data de entrega / por criacao.
- Contador do resultado.

### Linha de atividade (o coracao)
Cada item mostra, em camadas de densidade:
- **Letra de atalho** (coluna esquerda) - aperte para acionar.
- **Icone/cor de status**: em andamento (azul), bloqueado (ambar), idle/pendente (cinza), concluida (verde).
- **Titulo** + **badge de estado da sessao** (running/idle/ended/unknown).
- **Metadados**: squad - modulo - "atualizada ha X".
- **Branches** (chips).
- **Correlacao**: MRs com estado de review (chip colorido) + itens Azure. Degradado mostra timestamp + aviso.
- **Ultimo log** ("onde paramos") em uma linha.

Interacoes por linha:
- Clique / `Enter` / letra: acao primaria (focar-ou-abrir sessao).
- Hover: revela acoes secundarias (copiar comando, abrir MR, concluir, menu ...).
- Menu de contexto (botao direito / `Cmd+.`): todas as acoes.

### Rodape
- Sugestao contextual: sessoes orfas ("N sessoes ativas sem atividade -> associar").
- Atalho para command palette (`Cmd+K`).

---

## Estados especiais (tela honesta)

| Estado | O que aparece |
|--------|---------------|
| Daemon offline | Card central "Daemon kxd offline" + botao "Iniciar" + como diagnosticar. Nao mostra lista vazia sem explicar. |
| Projeto sem atividades | "Nenhuma atividade em andamento. [Criar atividade] ou [Ver concluidas]". |
| VPN caida (projeto que exige) | Faixa ambar no topo do corpo: "VPN do ambiente desconectada - correlacao pausada" + timestamp do ultimo dado + botao reconectar. Atividades continuam visiveis. |
| Correlacao degradada | Chip do MR fica cinza com "?" + tooltip do motivo (401, timeout). |
| Sessao indeterminada | Badge "?" em vez de running/ended. |
| Busca sem resultado | "Nada encontrado para '<q>'. Limpar filtro." |

---

## Command palette (Cmd+K)

Lista de acoes fuzzy-search, estilo Raycast:
- Trocar para projeto X
- Criar atividade
- Concluir atividade selecionada
- Marcar avanco / bloqueio
- Copiar comando de retomada
- Abrir MR no browser
- Atualizar correlacao (refresh DevOps)
- Abrir Settings
- Reiniciar daemon

---

## Settings (painel dedicado)

Aberto pelo `gear`. Abas internas:

1. **Aparencia**
   - Slider de transparencia (0-100%, default 60%) - efeito ao vivo.
   - Material de vibrancy (hud / popover / under-window).
   - Tema: seguir sistema / claro / escuro.
   - Densidade: compacta / confortavel.
2. **Projetos**
   - Lista de projetos (aba, cor, ordem, path do `.kx.json`).
   - Adicionar manual / auto-descobrir.
   - Por projeto: config GitLab (grupo, mapa de repos, metodo de auth), Azure (org, project, auth), `requiresVpn`.
3. **Terminal e retomada**
   - Terminal preferido + cadeia de fallback.
   - Metodo Warp; acao default (focar-ou-abrir / abrir / copiar).
   - Flag skip-permissions; prefixo `cd`; wrapper de shell.
   - Botao "testar terminal" (forca prompt de permissao TCC).
4. **Atalhos**
   - Hotkey global de abrir.
   - Atalhos por projeto.
   - Rebind das teclas internas.
5. **Notificacoes e alarme**
   - Ligar/desligar por tipo de evento (sessao terminou, MR mudou, lembrete).
   - Som.
   - Lembretes por atividade (ex.: "cutucar em 2h").
6. **Daemon**
   - Porta, status, logs, iniciar/parar, instalar LaunchAgent.
   - Token local.

---

## Comportamento visual da transparencia

- Fundo = `NSVisualEffectView` (material do sistema), nao um cinza fixo. Adapta light/dark.
- O slider controla a opacidade de uma camada de superficie sobre o material (0% = so o blur do sistema; 100% = solido).
- Regra de legibilidade: texto sempre com contraste minimo garantido; em transparencia alta, aumenta o peso/opacidade do texto e das divisorias automaticamente para nao perder leitura.
- Chips e badges tem fundo semi-solido proprio para permanecerem legiveis sobre qualquer parede atras da janela.

---

## Acessibilidade e conforto

- 100% navegavel por teclado (requisito, doc 07).
- Respeita "Reduzir transparencia" e "Reduzir movimento" do macOS (se ligado, cai para fundo solido / sem animacao).
- Alvos de clique >= 28px de altura na densidade confortavel.
- Tooltips em todo indicador de estado (nunca so cor - sempre cor + texto/icone).
