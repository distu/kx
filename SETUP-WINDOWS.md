# kx no Windows 10 - Guia de Instalação e Uso com Claude Code

> Guia completo, em ordem, para instalar o MCP `kx` no Windows 10, configurar globalmente no Claude Code e usar por projeto com **isolamento total** (zero cruzamento de informação entre projetos) e **zero risco de vazamento** (vault e docs ficam fora do repositório).

---

## Conceitos antes de começar

`kx` é um servidor MCP local que indexa pastas de cada projeto (docs, código, configs, vault) em um banco SQLite vetorial. O Claude Code consulta esse banco via MCP para responder com base no seu conhecimento privado.

**Arquitetura por projeto:**

```
C:\dev\projeto-x\                      <- pasta raiz do projeto (workspace)
├── repo-clonado-x\                    <- repositório Git (clonado do remoto)
│   ├── src\
│   ├── ...
│   └── (NUNCA contém docs\ nem .vault\)
├── docs\                              <- artefatos gerados pelo Claude (fora do repo)
├── .vault\                            <- secrets, segredos, anotações sensíveis
├── .kx.json                           <- config do kx (sources do projeto)
└── .mcp.json                          <- registra kx como MCP local do projeto
```

**Isolamento garantido por:**
- Cada projeto tem seu próprio `.kx.json` apontando para um SQLite dedicado em `%USERPROFILE%\.kx\data\<projeto>.sqlite`
- Zero compartilhamento entre projetos (database file separado por projeto)
- `docs\` e `.vault\` ficam **fora** do diretório do repositório, então o `.gitignore` nem precisa cobrir — não tem como serem commitados

---

## Parte 1 — Pré-requisitos Windows 10

### 1.1. Node.js 22 LTS ou superior

Baixe e instale: https://nodejs.org/en/download

Marque a opção **"Automatically install the necessary tools..."** durante o instalador (instala Chocolatey + Visual Studio Build Tools + Python). Isso é necessário porque `better-sqlite3` compila nativo.

Verifique:

```powershell
node --version
npm --version
```

Resultado esperado: `v22.x.x` (ou superior) e `10.x.x`.

### 1.2. Visual Studio Build Tools (caso o instalador do Node não tenha instalado)

Se `npm install` reclamar de "MSBUILD.EXE not found" ou "node-gyp" failing:

1. Baixe **Visual Studio 2022 Build Tools**: https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. No instalador, marque o workload **"Desktop development with C++"**
3. Reinicie o terminal após a instalação

### 1.3. Git for Windows

Baixe e instale: https://git-scm.com/download/win

Aceite os padrões. Isso instala `git`, `git bash` e abre suporte a comandos Unix-like no terminal.

### 1.4. Claude Code

Baixe e instale: https://docs.claude.com/en/docs/claude-code

Faça login com sua conta Anthropic ao abrir pela primeira vez.

---

## Parte 2 — Clonar e preparar o kx (uma vez só)

### 2.1. Escolha onde clonar

Recomendo: `C:\Users\<seu-usuario>\kx` (ou onde preferir, mas ANOTE o caminho exato — você vai precisar dele em todos os passos seguintes).

```powershell
cd C:\Users\<seu-usuario>
git clone https://github.com/distu/kx.git
cd kx
```

> Importante: você precisa estar autorizado no repositório `distu/kx`. Aceite o convite que recebeu por email antes de tentar clonar.

### 2.2. Instalar dependências

```powershell
cd C:\Users\<seu-usuario>\kx
npm install
```

Isso baixa tudo e compila `better-sqlite3` nativo. Pode demorar alguns minutos.

### 2.3. Validar instalação

```powershell
node bin\kx.js --help
```

Deve listar os comandos `search`, `index`, `status`, `watch`, `mcp`.

Anote o caminho absoluto do `kx.js`:

```powershell
echo %USERPROFILE%\kx\bin\kx.js
```

Exemplo: `C:\Users\fulano\kx\bin\kx.js`

---

## Parte 3 — Configuração GLOBAL do MCP no Claude Code

A configuração global registra o `kx` como MCP server disponível em **todos os projetos** do Claude Code do seu usuário Windows.

### 3.1. Localizar o arquivo de configuração global

No Windows, o arquivo é:

```
%USERPROFILE%\.claude.json
```

Caminho real (exemplo): `C:\Users\fulano\.claude.json`

Se o arquivo não existir ainda, ele será criado quando o Claude Code for executado pela primeira vez. Abra o Claude Code uma vez antes de continuar.

### 3.2. Adicionar o `kx` aos `mcpServers`

Abra `%USERPROFILE%\.claude.json` em um editor (VSCode, Notepad++, etc.) e adicione/atualize a chave `mcpServers`:

```json
{
  "mcpServers": {
    "kx": {
      "command": "node",
      "args": [
        "C:\\Users\\fulano\\kx\\bin\\kx.js",
        "mcp"
      ]
    }
  }
}
```

**Substitua `C:\\Users\\fulano\\kx\\bin\\kx.js`** pelo caminho real do seu `kx.js` (use barras duplas `\\` em JSON).

> Observação importante sobre comportamento global vs projeto:
> Quando você abrir o Claude Code dentro de um diretório de projeto que tenha um `.mcp.json` próprio (Parte 4), o arquivo do projeto **tem prioridade** e o kx será inicializado com o contexto daquele projeto. Sem `.mcp.json` local, o kx global é usado e cai num fallback de configuração em `%USERPROFILE%\.kx.json` (se existir).

### 3.3. (Opcional, mas recomendado) Fallback global `~/.kx.json`

Crie um `.kx.json` mínimo no seu home para evitar erros caso o Claude Code abra sem `.kx.json` de projeto:

`%USERPROFILE%\.kx.json`:

```json
{
  "project": "global-fallback",
  "index": "C:\\Users\\fulano\\.kx\\data\\global-fallback.sqlite",
  "sources": []
}
```

Isso garante que o MCP suba sem erro mesmo fora de qualquer projeto.

### 3.4. Validar o MCP global

Feche e reabra o Claude Code. Em qualquer diretório, digite no chat:

```
/mcp
```

Deve listar `kx` como servidor disponível.

---

## Parte 4 — Estrutura e configuração POR projeto (zero cruzamento)

Para cada projeto novo que o Claude Code vai assistir, repita os passos abaixo. **Cada projeto tem o seu próprio banco vetorial, isolado dos demais.**

### 4.1. Criar o workspace do projeto

```powershell
mkdir C:\dev\projeto-x
cd C:\dev\projeto-x
```

### 4.2. Clonar o repositório DENTRO do workspace

```powershell
cd C:\dev\projeto-x
git clone <url-do-repo-do-projeto-x> repo-x
```

Agora a estrutura é:

```
C:\dev\projeto-x\
└── repo-x\           <- código do projeto
```

### 4.3. Criar `docs\` e `.vault\` FORA do repo

```powershell
cd C:\dev\projeto-x
mkdir docs
mkdir .vault
```

Estrutura resultante:

```
C:\dev\projeto-x\
├── repo-x\           <- repositório Git (commits vão pra lá)
├── docs\             <- artefatos gerados (FORA do repo)
└── .vault\           <- arquivos sensíveis (FORA do repo)
```

> Como `docs\` e `.vault\` estão **um nível acima** do repo, eles nunca aparecem em `git status` do repositório. Zero risco de commit acidental, zero necessidade de `.gitignore` para eles.

### 4.4. Criar `.kx.json` na raiz do workspace (não dentro do repo)

`C:\dev\projeto-x\.kx.json`:

```json
{
  "project": "projeto-x",
  "index": "C:\\Users\\fulano\\.kx\\data\\projeto-x.sqlite",
  "sources": [
    {
      "type": "docs",
      "path": "./docs",
      "glob": "**/*.md"
    },
    {
      "type": "vault",
      "path": "./.vault",
      "glob": "**/*.md",
      "exclude": ["**/templates/**", "**/.obsidian/**", "**/.trash/**"]
    },
    {
      "type": "code",
      "path": "./repo-x",
      "glob": "**/*.{ts,tsx,js,jsx,py,java,go,rs,cs}",
      "exclude": [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/.git/**",
        "**/test/**",
        "**/tests/**"
      ]
    },
    {
      "type": "config",
      "path": "./repo-x",
      "glob": "**/{*.yml,*.yaml,*.json,*.properties,.env*,docker-compose*,Dockerfile*,*.xml,*.toml}",
      "exclude": [
        "**/node_modules/**",
        "**/build/**",
        "**/target/**",
        "**/.git/**"
      ]
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

**Pontos críticos:**
- `"index"`: caminho absoluto Windows com `\\`. **Use um nome único por projeto** (`projeto-x.sqlite`, `projeto-y.sqlite`, etc.). É isso que garante o isolamento.
- `"sources[].path"`: relativo ao diretório do `.kx.json`. Ajuste os globs conforme a stack do projeto.
- Ajuste `exclude` para pastas pesadas (`node_modules`, `build`, `dist`, `.git`).

### 4.5. Criar `.mcp.json` na raiz do workspace

`C:\dev\projeto-x\.mcp.json`:

```json
{
  "mcpServers": {
    "kx": {
      "command": "node",
      "args": [
        "C:\\Users\\fulano\\kx\\bin\\kx.js",
        "mcp"
      ]
    }
  }
}
```

> Esse arquivo faz o Claude Code, ao abrir nesse workspace, subir o kx **vinculado ao `.kx.json` local** — ou seja, com o sqlite isolado do projeto.

### 4.6. Indexar o projeto pela primeira vez

```powershell
cd C:\dev\projeto-x
node C:\Users\fulano\kx\bin\kx.js index --full
```

Isso lê todos os `sources` declarados, gera embeddings e popula o `projeto-x.sqlite`. Demora alguns minutos na primeira vez (carrega o modelo de embedding).

Verifique:

```powershell
node C:\Users\fulano\kx\bin\kx.js status
```

Deve mostrar contagem de documentos e chunks indexados.

### 4.7. (Opcional) Auto-reindex em segundo plano

Em outra janela do terminal, deixe rodando enquanto trabalha:

```powershell
cd C:\dev\projeto-x
node C:\Users\fulano\kx\bin\kx.js watch
```

Isso observa mudanças nos arquivos e reindexa incrementalmente. Pode fechar quando terminar de trabalhar no projeto.

---

## Parte 5 — Tornar o kx a ferramenta nº1 de consulta do Claude Code

Para forçar o Claude Code a **sempre consultar o kx antes de responder**, crie/edite um `CLAUDE.md` na raiz do **workspace do projeto** (não dentro do repo):

`C:\dev\projeto-x\CLAUDE.md`:

```markdown
# Contexto do Projeto

Este workspace usa o MCP `kx` como **fonte primária de conhecimento** sobre o projeto.

## Regras obrigatórias

1. **Antes de responder qualquer pergunta sobre código, arquitetura, decisões, segredos ou histórico do projeto, chame primeiro a tool `kx_search` do MCP `kx`.**
2. Só responda com base no que o `kx_search` retornar. Se a busca não trouxer nada relevante, diga explicitamente que não encontrou e pergunte se deve ler arquivos diretamente.
3. Para perguntas sobre credenciais, hosts, decisões internas ou anotações pessoais, busque com `--type vault`.
4. Para perguntas sobre código, busque com `--type code`. Para docs, `--type docs`. Para configs, `--type config`.
5. **Nunca commitar arquivos de `..\docs\` ou `..\.vault\`** — essas pastas estão fora do repositório por design.

## Estrutura do workspace

- `repo-x\` — repositório Git (commits vão pra lá)
- `docs\` — artefatos gerados (NUNCA commitar)
- `.vault\` — secrets, credenciais, anotações sensíveis (NUNCA commitar)
- `.kx.json` — config do MCP kx (sources indexadas)
- `.mcp.json` — registra kx como MCP do Claude Code deste workspace

## Ao gerar artefatos novos

Salve sempre em `..\docs\` quando for documentação do projeto, e em `..\.vault\` quando for credencial ou nota sensível.
```

> Esse `CLAUDE.md` é lido automaticamente pelo Claude Code ao abrir o workspace e injetado no system prompt. Ele é o que força o comportamento "kx primeiro".

---

## Parte 6 — Repetir para cada novo projeto

Para um **projeto Y diferente**, repita a Parte 4 inteira em outro workspace:

```
C:\dev\projeto-y\
├── repo-y\
├── docs\
├── .vault\
├── .kx.json     <- "index": "C:\\Users\\fulano\\.kx\\data\\projeto-y.sqlite"
├── .mcp.json
└── CLAUDE.md
```

Como o `index` aponta para um `.sqlite` **diferente**, o projeto Y nunca verá dados do projeto X, e vice-versa. Você pode trabalhar em ambos simultaneamente — cada Claude Code aberto enxerga apenas o seu sqlite.

---

## Parte 7 — Comandos do dia-a-dia

Sempre execute dentro do diretório do workspace do projeto (onde está o `.kx.json`):

```powershell
# Busca semântica (CLI)
node C:\Users\fulano\kx\bin\kx.js search "como funciona o login"
node C:\Users\fulano\kx\bin\kx.js search "credenciais do banco QA" --type vault
node C:\Users\fulano\kx\bin\kx.js search "SecurityConfig" --type code --top 3

# Reindexação
node C:\Users\fulano\kx\bin\kx.js index           # incremental
node C:\Users\fulano\kx\bin\kx.js index --full    # do zero

# Status do índice
node C:\Users\fulano\kx\bin\kx.js status

# Watcher (deixar rodando em background)
node C:\Users\fulano\kx\bin\kx.js watch
```

### Atalho via npm script (opcional)

Para evitar digitar o path completo, edite `C:\Users\fulano\kx\package.json` e adicione um script global:

```json
{
  "bin": {
    "kx": "./bin/kx.js"
  }
}
```

E rode uma vez:

```powershell
cd C:\Users\fulano\kx
npm link
```

Agora você pode chamar só `kx search "..."` em qualquer terminal.

---

## Parte 8 — Troubleshooting Windows

### "node-gyp" ou "MSBUILD" falham no `npm install`

Instale Visual Studio Build Tools (Parte 1.2) e rode:

```powershell
cd C:\Users\fulano\kx
npm rebuild better-sqlite3
```

### "Cannot find module 'better-sqlite3'" ao subir o MCP

O Node mudou de versão e o módulo nativo ficou com ABI incompatível. Solução:

```powershell
cd C:\Users\fulano\kx
npm rebuild better-sqlite3
```

### `/mcp` no Claude Code não lista o kx

1. Confirme que o caminho no `.mcp.json` (ou `.claude.json`) existe de verdade
2. Use barras duplas `\\` no JSON
3. Feche e reabra o Claude Code
4. Veja logs em `%USERPROFILE%\.kx\logs\` (criados na primeira execução do MCP)

### MCP sobe mas `kx_search` retorna vazio

Você esqueceu de indexar:

```powershell
cd C:\dev\projeto-x
node C:\Users\fulano\kx\bin\kx.js index --full
```

### Como verificar qual `.kx.json` o MCP carregou

O MCP procura nessa ordem:
1. `KX_PROJECT_ROOT` (env var, se definida)
2. `.kx.json` no `cwd` e nos diretórios pais
3. `%USERPROFILE%\.kx.json` (fallback global)

Para forçar um projeto específico, defina antes de abrir o Claude Code:

```powershell
set KX_PROJECT_ROOT=C:\dev\projeto-x
```

---

## Parte 9 — Checklist final por projeto

Antes de começar a trabalhar em um projeto novo, confirme:

- [ ] `C:\dev\<projeto>\repo-<projeto>\` existe (repo clonado)
- [ ] `C:\dev\<projeto>\docs\` existe (vazia ou com docs gerados)
- [ ] `C:\dev\<projeto>\.vault\` existe (vazia ou com notas sensíveis)
- [ ] `C:\dev\<projeto>\.kx.json` existe com `index` único (`<projeto>.sqlite`)
- [ ] `C:\dev\<projeto>\.mcp.json` existe registrando o kx
- [ ] `C:\dev\<projeto>\CLAUDE.md` existe com a regra "kx primeiro"
- [ ] Rodou `node ...\kx.js index --full` pelo menos uma vez
- [ ] `/mcp` no Claude Code lista `kx`
- [ ] Confirmou que `..\docs\` e `..\.vault\` NÃO aparecem em `git status` do repo

---

## Parte 10 — Dúvidas frequentes

**P: Posso colocar `docs\` e `.vault\` dentro do repo?**
R: Pode, desde que estejam no `.gitignore`. Mas o desenho recomendado é **fora**, porque elimina qualquer risco de commit acidental.

**P: O kx envia dados para a Anthropic ou alguma nuvem?**
R: Não. Embeddings rodam in-process com Transformers.js (modelo `all-MiniLM-L6-v2`, 23MB, offline). Tudo fica no SQLite local em `%USERPROFILE%\.kx\data\`.

**P: Posso ter dois projetos abertos em Claude Codes diferentes ao mesmo tempo?**
R: Sim. Cada janela do Claude Code lê o `.mcp.json` do workspace que abriu, e cada MCP aponta para um `.sqlite` separado. Zero cruzamento.

**P: Como dou backup dos dados?**
R: Backup de `%USERPROFILE%\.kx\data\*.sqlite`. Cada arquivo é um projeto.

**P: E se eu quiser zerar um projeto?**
R: Delete o `.sqlite` correspondente e rode `index --full` de novo.

---

## Resumo executivo (cole isso pro Claude Code do seu amigo configurar tudo)

```
Você é o Claude Code rodando no Windows 10 do meu amigo. Siga o guia
SETUP-WINDOWS.md (que está em https://github.com/distu/kx/blob/main/SETUP-WINDOWS.md)
e execute estes passos comigo:

1. Confirme que Node.js 22+ e Git estão instalados (rode "node --version" e "git --version").
2. Pergunte onde ele clonou o repositório kx (caminho absoluto Windows).
3. Configure o MCP kx globalmente em %USERPROFILE%\.claude.json apontando pro kx.js dele.
4. Crie %USERPROFILE%\.kx.json com fallback vazio.
5. Para o projeto atual:
   a. Pergunte o nome do projeto e o caminho do workspace (ex: C:\dev\meu-projeto).
   b. Crie a estrutura: workspace/repo-clonado, workspace/docs, workspace/.vault.
   c. Crie workspace/.kx.json com sources apontando pra ./docs, ./.vault, ./repo-clonado
      e index único em %USERPROFILE%\.kx\data\<projeto>.sqlite.
   d. Crie workspace/.mcp.json registrando kx via node + caminho absoluto do kx.js.
   e. Crie workspace/CLAUDE.md com a regra "consulte kx antes de responder qualquer coisa".
6. Rode "node <path>\kx\bin\kx.js index --full" no workspace pra popular o sqlite.
7. Confirme que /mcp lista o kx ativo.
8. Lembre o usuário: docs\ e .vault\ NUNCA são commitados (ficam fora do repo).
9. Para cada novo projeto, repetir o passo 5 com um nome de sqlite diferente.
```
