# kx — Quick Start para Novos Projetos

> Guia rápido para adicionar kx a um projeto novo em ~15 minutos.

---

## Pré-requisitos

- Node.js 22+ (via fnm, nvm ou direto)
- kx instalado em `~/.kx/` (binário global)
- Obsidian instalado (`brew install --cask obsidian`)

## Passo 1: Criar `.kx.json` na raiz do projeto (2 min)

```json
{
  "project": "nome-do-projeto",
  "index": "/absolute/path/to/home/.kx/data/nome-do-projeto.sqlite",
  "sources": [
    {
      "type": "docs",
      "path": "./docs",
      "glob": "**/*.md",
      "exclude": ["**/node_modules/**", "**/.git/**"]
    },
    {
      "type": "vault",
      "path": "./.vault",
      "glob": "**/*.md",
      "exclude": ["**/templates/**", "**/.obsidian/**", "**/.trash/**"]
    },
    {
      "type": "code",
      "path": "./src",
      "glob": "**/*.{java,ts,tsx,py,go}",
      "exclude": ["**/test/**", "**/build/**", "**/node_modules/**", "**/.git/**"]
    },
    {
      "type": "config",
      "path": ".",
      "glob": "**/{*.yml,*.yaml,*.properties,.env*,docker-compose*,Dockerfile*,package.json,tsconfig.json}",
      "exclude": ["**/node_modules/**", "**/build/**", "**/.git/**"]
    }
  ],
  "embedding": {
    "model": "Xenova/all-MiniLM-L6-v2",
    "dimensions": 384
  },
  "chunking": {
    "markdown": { "maxTokens": 512, "overlap": 50 },
    "code": { "maxTokens": 1024, "overlap": 0 },
    "config": { "maxTokens": 256, "overlap": 0 }
  }
}
```

Ajuste `sources` conforme a estrutura do projeto (paths, globs, linguagens).

## Passo 2: Criar `.mcp.json` na raiz do projeto (1 min)

```json
{
  "mcpServers": {
    "kx": {
      "command": "node",
      "args": ["/absolute/path/to/home/.kx/bin/kx.js", "mcp"]
    }
  }
}
```

## Passo 3: Criar vault Obsidian (5 min)

```bash
# Criar estrutura
mkdir -p .vault/{_index,_secrets,architecture/{adr,diagrams},services,integrations,standards,database,meetings,decisions,sprint,team/{squads,members},cheatsheets,templates,_attachments}

# Adicionar ao .gitignore do projeto
echo ".vault/" >> .gitignore

# Inicializar git local (backup)
cd .vault && git init
cat > .gitignore << 'EOF'
.obsidian/workspace.json
.obsidian/app.json
.obsidian/appearance.json
.obsidian/hotkeys.json
.trash/
.DS_Store
EOF
cd ..
```

Abrir no Obsidian: Open folder as vault → selecionar `.vault/`

Configurar:
- Settings → Community Plugins → Turn on
- Instalar: Linter, Templater, Obsidian Git, Dataview, Excalidraw, Graph Analysis
- Settings → Templater → Template folder: `templates`
- Settings → Files & Links → Use Wikilinks: **ON**

## Passo 4: Adicionar instrução no CLAUDE.md (2 min)

Adicionar no topo do CLAUDE.md do projeto:

```markdown
## MCP kx (Obrigatório)

Este projeto possui um MCP server (`kx`) com busca semântica indexada. **SEMPRE usar a tool `search` do MCP `kx` ANTES de:**

- Implementar ou refatorar qualquer código (buscar padrões do projeto)
- Responder perguntas sobre arquitetura, fluxos ou decisões
- Criar endpoints, DTOs, services, migrations (buscar padrões e exemplos)
- Fazer code review (buscar padrões e regras)

**NÃO usar Glob/Grep/Read como primeira opção para perguntas conceituais.**
```

## Passo 5: Indexar (5 min)

```bash
# Primeira indexação completa
kx index --full

# Verificar resultado
kx status
```

## Passo 6: Auto-start (opcional, 2 min)

Criar `~/Library/LaunchAgents/com.kx.nome-do-projeto.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kx.nome-do-projeto</string>
    <key>ProgramArguments</key>
    <array>
        <string>/absolute/path/to/home/.local/share/fnm/node-versions/v25.8.1/installation/bin/node</string>
        <string>/absolute/path/to/home/.kx/bin/kx.js</string>
        <string>watch</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/caminho/absoluto/do/projeto</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/tmp/kx-nome-do-projeto.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/kx-nome-do-projeto.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>HOME</key>
        <string>/absolute/path/to/home</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.kx.nome-do-projeto.plist
```

## Passo 7: Testar

```bash
# CLI
kx search "qualquer coisa do projeto"

# Abrir nova sessão Claude Code no projeto
# Perguntar algo — Claude deve usar kx automaticamente
```

---

## Templates de Vault Disponíveis

Copiar de qualquer vault existente ou usar Templater no Obsidian:

| Template | Uso |
|---|---|
| `tpl-meeting.md` | Notas de reunião |
| `tpl-adr.md` | Architecture Decision Record |
| `tpl-service.md` | Contexto de microsserviço |
| `tpl-decision.md` | Decisão técnica pessoal |
| `tpl-secret.md` | Credencial/token |
| `tpl-sprint.md` | Contexto de sprint |
| `tpl-squad.md` | Squad com ferramentas e membros |
| `tpl-team-member.md` | Membro com IDs (agile + git) |

---

## Checklist

- [ ] `.kx.json` criado com sources do projeto
- [ ] `.mcp.json` criado apontando para `~/.kx/bin/kx.js`
- [ ] `.vault/` criado com estrutura completa
- [ ] `.vault/` no `.gitignore`
- [ ] Git local no vault inicializado
- [ ] Obsidian aberto e plugins instalados
- [ ] CLAUDE.md com instrução do MCP kx
- [ ] `kx index --full` executado
- [ ] `kx status` mostra chunks
- [ ] `kx search` retorna resultados
- [ ] launchd configurado (opcional)
- [ ] Nova sessão Claude Code testada

---

*Tempo total: ~15 minutos por projeto*
