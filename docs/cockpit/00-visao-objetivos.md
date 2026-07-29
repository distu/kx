# 00 - Visao e Objetivos

## Persona unica

**A pessoa desenvolvedora** - arquiteto/tech lead que opera varios projetos em paralelo (Projeto A, Projeto B, projetos pessoais), cada um com multiplas atividades, multiplas sessoes do Claude Code, branches, MRs no GitLab e itens no Azure DevOps. Contexto muda o tempo todo. A dor central e **reconstruir contexto**: "onde eu parei nessa atividade? qual sessao era? qual branch? o MR ja foi revisado?".

Non-persona: nao e um produto multi-usuario, nao e SaaS, nao tem login. E ferramenta pessoal de altissima densidade de informacao, feita sob medida.

## Visao

> Um vislumbre de 2 segundos no menu bar deve responder: **o que esta vivo agora, em qual projeto, e como volto pra la imediatamente** - sem abrir terminal, sem `grep`, sem lembrar UUID de sessao.

## Objetivos mensuraveis (o "pronto" do produto)

| # | Objetivo | Metrica de sucesso |
|---|----------|--------------------|
| O1 | Reduzir tempo de retomada de contexto | Do clique no icone ate estar de volta na sessao certa em < 3 segundos (1 clique ou 1 tecla) |
| O2 | Visao unificada e isolada | Ver todas as atividades de um projeto sem ver nenhuma de outro; trocar de projeto em 1 clique/atalho |
| O3 | Correlacao sem esforco | Ver, por atividade, branches + MRs (com estado de review) + itens Azure, sem sair do painel |
| O4 | Zero divergencia de dados | O que o Cockpit mostra e escreve e byte-a-byte compativel com as tools MCP do KX activity manager |
| O5 | Presenca ambiente | Saber sem clicar (badge no icone da menu bar) quantas atividades estao em andamento / bloqueadas |
| O6 | Acao autonoma | Saltar pra sessao, copiar comando, abrir/focar terminal - tudo sem tocar no mouse se quiser (hotkeys) |

## Non-goals (o que o Cockpit NAO e)

- **Nao substitui o editor nem o terminal.** Ele orquestra, nao edita codigo.
- **Nao e um cliente MCP.** Ele fala com o daemon `kxd` por HTTP; nao implementa o protocolo MCP.
- **Nao e multi-plataforma.** E macOS nativo. Cross-platform foi explicitamente descartado (menu bar so existe no macOS; a decisao de stack SwiftUI foi tomada com base nisso).
- **Nao gerencia os tokens de terceiros por conta propria alem do necessario.** Reusa Keychain / `.vault/_secrets`.
- **Nao inventa estado.** Se nao consegue determinar se uma sessao esta "rodando agora", mostra "indeterminado", nunca chuta.
- **Nao e um kanban colaborativo.** MOC e KX activity manager ja existem; o Cockpit e a camada de visualizacao/acao pessoal em cima deles.

## Principios de design

1. **Densidade com respiro.** Muita informacao por pixel, mas hierarquia visual clara (o padrao dos bons menu bar apps: FineTune, Later). Nada de scroll infinito sem ancora.
2. **Uma acao primaria por linha.** Cada atividade tem UMA acao obvia (saltar pra sessao). O resto e secundario (menu de contexto, hover).
3. **Teclado primeiro.** Tudo alcancavel por atalho. Mouse e conveniencia, nao requisito.
4. **Transparencia como identidade visual, nao enfeite.** Vibrancy nativo (`NSVisualEffectView`), opacidade configuravel, legivel em light e dark.
5. **Falha honesta.** Daemon fora do ar, token expirado, VPN caida: o Cockpit diz exatamente o que esta quebrado e como resolver, nunca finge estar OK.
6. **Isolamento visivel.** A aba ativa deixa claro em qual projeto voce esta; erro de contexto cruzado e impossivel por construcao (o daemon so entrega o projeto pedido).

## Cenarios de uso (histórias reais)

- **"Voltei do almoco"**: clico no icone, aba `fase2` ja aberta, vejo 3 atividades em andamento ordenadas por recencia, aperto `a` na primeira -> Warp abre na sessao com o comando de resume pronto.
- **"O MR ja foi revisado?"**: passo o mouse na atividade "feature de exemplo", vejo `service-a !123 aprovado`, `service-b !456 aguardando review`. Nao preciso abrir o GitLab.
- **"Troquei de contexto pro projeto-b"**: `Cmd+2` (ou clico na aba `project-b`), lista muda completamente, nenhuma atividade do organização aparece.
- **"Terminei uma feature"**: seleciono a atividade, aciono "Concluir", o Cockpit chama a mesma logica do `megabrain_update tipo=conclusao`, o `.md` e o MOC sao atualizados, e a atividade sai de "Em andamento".
- **"Esqueci de registrar"**: o Cockpit percebe que ha uma sessao ativa (`.jsonl` sendo escrito agora) sem atividade associada e sugere criar/associar uma - sem forcar.
