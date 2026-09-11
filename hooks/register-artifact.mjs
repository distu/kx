#!/usr/bin/env node
// Hook PostToolUse da ferramenta Artifact: registra no vault do projeto todo artefato web
// publicado, vinculado a atividade do KX activity manager em que o trabalho aconteceu.
//
// Contrato: NUNCA bloqueia e NUNCA falha a sessao — qualquer erro vira linha de log e exit 0.
// Fora de um projeto kx (sem .kx.json na arvore), sai em silencio.
//
// Registro efetivo: `kx artifact add` (ver ~/distuai/kx/src/artifacts.ts).
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const KX_BIN = resolve(homedir(), '.kx', 'bin', 'kx-mcp.sh');
const LOG_DIR = resolve(homedir(), '.kx', 'logs');
const LOG_FILE = resolve(LOG_DIR, 'artifact-hook.log');

function log(msg) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch { /* log e best-effort */ }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

// Sobe a arvore procurando o .kx.json: e ele que define o projeto e, portanto, qual .vault
// recebe o registro. Sem ele, este hook nao tem onde escrever e simplesmente nao age.
function findProjectRoot(start) {
  let dir = resolve(start || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (existsSync(resolve(dir, '.kx.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// O titulo que o usuario reconhece e o <title> da pagina; o input da tool so o traz quando
// o arquivo nao tem tag. Ordem: input.title -> <title> do arquivo -> nome do arquivo.
function extractTitle(input) {
  if (input.title && String(input.title).trim()) return String(input.title).trim();
  const p = input.file_path;
  if (p && existsSync(p)) {
    try {
      const head = readFileSync(p, 'utf-8').slice(0, 8192);
      const m = head.match(/<title>([\s\S]*?)<\/title>/i);
      if (m) return m[1].replace(/\s+/g, ' ').trim();
    } catch { /* arquivo ilegivel: cai para o nome */ }
  }
  return p ? basename(p).replace(/\.(html?|md)$/i, '') : 'Artefato';
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log('payload nao e JSON; ignorado');
    return;
  }

  const toolName = payload.tool_name || '';
  if (!/(^|__)Artifact$/.test(toolName)) return;

  const input = payload.tool_input || {};
  // Acoes de leitura/gestao (read, list, comments, delete, watch...) nao publicam nada.
  if (input.action && input.action !== 'publish') return;

  // A prova de que houve publicacao e a resposta da tool, nao o input: so ela carrega a URL.
  const response = typeof payload.tool_response === 'string'
    ? payload.tool_response
    : JSON.stringify(payload.tool_response ?? '');
  const m = response.match(/\b(?:Published|Updated|Republished)\b[^\n]*?\bat\b\s+(https?:\/\/[^\s"\\]+)/i);
  if (!m) return;
  const url = m[1];

  const projectRoot = findProjectRoot(payload.cwd);
  if (!projectRoot) {
    log(`fora de projeto kx (cwd=${payload.cwd}); artefato ${url} nao registrado`);
    return;
  }
  if (!existsSync(KX_BIN)) {
    log(`kx nao encontrado em ${KX_BIN}; artefato ${url} nao registrado`);
    return;
  }

  const args = ['artifact', 'add', '--url', url, '--titulo', extractTitle(input), '--agente', 'claude-code'];
  if (input.description) args.push('--descricao', String(input.description));
  if (input.file_path) args.push('--arquivo', String(input.file_path));
  if (input.label) args.push('--label', String(input.label));
  if (payload.session_id) args.push('--sessao', String(payload.session_id));

  const r = spawnSync(KX_BIN, args, { cwd: projectRoot, encoding: 'utf-8', timeout: 25000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    log(`falha ao registrar ${url} (status=${r.status}): ${out.slice(0, 400)}`);
    return;
  }
  log(`registrado ${url} em ${projectRoot}`);

  // Artefato orfao e o unico caso que precisa da atencao do agente: ele sabe a que atividade
  // o trabalho pertence e pode vincular na hora.
  if (/SEM atividade vinculada/.test(out)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Artefato registrado em .vault/ARTEFATOS.md, porem SEM atividade vinculada. ' +
          'Se este trabalho pertence a uma atividade do KX activity manager, vincule com a tool ' +
          'megabrain_artifact_link (url + atividade); se ainda nao existe atividade, considere criar com megabrain_add.',
      },
    }));
  }
}

try {
  main();
} catch (e) {
  log(`erro inesperado: ${e && e.stack ? e.stack : e}`);
}
process.exit(0);
