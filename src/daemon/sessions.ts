// Descoberta das sessoes do Claude Code de um projeto, para o KX Cockpit.
// Os transcripts ficam em ~/.claude/projects/<slug>/<uuid>.jsonl, onde <slug> e o projectRoot
// com todo caractere nao-alfanumerico virando '-'. O <uuid> e o proprio session id (claude --resume).
// Leitura tolerante: nunca lanca; estado por mtime (heuristica honesta, refinavel com deteccao de processo).
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

export interface SessionInfo {
  sessionId: string;
  title: string;
  firstPrompt: string;
  startedAt: number;       // ms epoch
  lastActivityAt: number;  // ms epoch (mtime do transcript)
  state: 'running' | 'idle' | 'ended';
  resumeCommand: string;
}

const RUNNING_MS = 2 * 60 * 1000;       // escreveu nos ultimos 2 min -> provavelmente ativa
const IDLE_MS = 12 * 60 * 60 * 1000;    // ate 12h -> ociosa; mais que isso -> encerrada
const MAX_READ = 3 * 1024 * 1024;       // le no maximo 3MB do transcript por sessao

export function claudeProjectsDir(projectRoot: string): string {
  const slug = resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, '-');
  return resolve(homedir(), '.claude', 'projects', slug);
}

function excerpt(s: string, n = 140): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Extrai titulo (ultimo /rename) e primeiro prompt do usuario, de forma tolerante a formato.
function parseTranscript(path: string): { title: string; firstPrompt: string } {
  let content = '';
  try {
    content = readFileSync(path, 'utf-8');
    if (content.length > MAX_READ) {
      // head + tail: primeiro prompt costuma estar no inicio; o rename mais recente, no fim.
      content = content.slice(0, MAX_READ / 2) + '\n' + content.slice(-MAX_READ / 2);
    }
  } catch {
    return { title: '', firstPrompt: '' };
  }
  let title = '';
  // Captura o valor do /rename parando no fim do campo (evita arrastar o resto do JSON da linha).
  const renames = [...content.matchAll(/Session renamed to:\s*(.+?)\s*(?:<\/local-command-stdout>|["\\]|$)/gm)];
  if (renames.length) title = renames[renames.length - 1][1].trim();

  let firstPrompt = '';
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj?.type === 'user' && obj.message) {
      const c = obj.message.content;
      let text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((b: any) => (typeof b === 'string' ? b : b?.text || '')).join(' ') : '';
      text = text.replace(/<[^>]+>/g, ' ').replace(/system-reminder[\s\S]*/i, ' ').trim();
      if (text) { firstPrompt = excerpt(text); break; }
    }
  }
  if (!title) title = firstPrompt ? excerpt(firstPrompt, 60) : '(sessao sem titulo)';
  return { title, firstPrompt };
}

// parseLimit: quantos transcripts (os mais recentes) tem titulo/prompt lidos do disco.
// stat e barato e roda em todos; a leitura do conteudo (cara) fica so no topo por mtime.
export function listSessions(projectRoot: string, parseLimit = 80): SessionInfo[] {
  const dir = claudeProjectsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const now = Date.now();
  const files: { f: string; mtime: number; birth: number }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const st = statSync(resolve(dir, f));
      files.push({ f, mtime: st.mtimeMs, birth: st.birthtimeMs || st.ctimeMs });
    } catch { /* ignora arquivo ilegivel */ }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.map((e, idx) => {
    const sessionId = e.f.replace(/\.jsonl$/, '');
    const age = now - e.mtime;
    const state: SessionInfo['state'] = age < RUNNING_MS ? 'running' : age < IDLE_MS ? 'idle' : 'ended';
    const deep = idx < parseLimit;
    const parsed = deep ? parseTranscript(resolve(dir, e.f)) : { title: '', firstPrompt: '' };
    return {
      sessionId,
      title: parsed.title || (deep ? '(sessao sem titulo)' : ''),
      firstPrompt: parsed.firstPrompt,
      startedAt: Math.floor(e.birth),
      lastActivityAt: Math.floor(e.mtime),
      state,
      // Nunca habilitar bypass de permissões em um comando gerado pela aplicação.
      resumeCommand: `cd -- ${shellQuote(projectRoot)} && claude --resume ${shellQuote(sessionId)}`,
    };
  });
}
