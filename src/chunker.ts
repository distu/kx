export interface Chunk {
  content: string;
  index: number;
  metadata: Record<string, unknown>;
}

/**
 * Orçamento seguro de tokens para o modelo de embedding.
 *
 * O all-MiniLM-L6-v2 trunca silenciosamente em 512 tokens: tudo que passa
 * disso é gravado no índice mas nunca entra no vetor — o texto fica
 * inencontrável pelo próprio conteúdo. Medição real neste projeto mostrou
 * 51% dos chunks de código truncados quando o chunking confiava no limite
 * nominal. O orçamento fica abaixo do limite com margem para a variação da
 * estimativa de tokens.
 */
export const EMBED_SAFE_TOKENS = 440;

/**
 * Estima tokens a partir de caracteres.
 *
 * A heurística clássica de ~4 caracteres por token vale para inglês corrente,
 * mas o tokenizer do MiniLM produz ~2,9 caracteres por token em português e
 * menos ainda em código (identificadores compostos viram vários subtokens).
 * Medição com o tokenizer real: 575 caracteres -> 201 tokens. O divisor 3 é
 * conservador de propósito: superestimar tokens gera chunks um pouco menores;
 * subestimar gera truncamento silencioso.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Caracteres equivalentes ao overlap configurado em tokens. */
function overlapChars(overlapTokens: number): number {
  return overlapTokens * 3;
}

function clampToEmbedBudget(maxTokens: number): number {
  return Math.min(maxTokens, EMBED_SAFE_TOKENS);
}

/**
 * Chunking para Markdown: divide por headers, depois por tamanho.
 */
export function chunkMarkdown(
  content: string,
  maxTokens: number = 512,
  overlap: number = 50
): Chunk[] {
  const budget = clampToEmbedBudget(maxTokens);

  // Remover wikilinks para indexação, preservando o texto
  const cleaned = content.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_match, target, _pipe, alias) => {
    return alias || target;
  });

  const sections = splitByHeaders(cleaned);
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    if (estimateTokens(section.content) <= budget) {
      chunks.push({
        content: section.content.trim(),
        index: index++,
        metadata: { header: section.header },
      });
    } else {
      const subChunks = recursiveSplit(section.content, budget, overlap);
      for (const sub of subChunks) {
        chunks.push({
          content: sub.trim(),
          index: index++,
          metadata: { header: section.header },
        });
      }
    }
  }

  return chunks.filter(c => c.content.length > 20);
}

/**
 * Chunking para código: divide por funções/métodos/classes.
 */
export function chunkCode(
  content: string,
  maxTokens: number = 1024,
  filePath: string = ''
): Chunk[] {
  const budget = clampToEmbedBudget(maxTokens);
  const isJava = filePath.endsWith('.java');
  const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

  const chunks: Chunk[] = [];
  let index = 0;

  const pushBounded = (text: string, metadata: Record<string, unknown>) => {
    if (estimateTokens(text) <= budget) {
      chunks.push({ content: text.trim(), index: index++, metadata });
      return;
    }
    for (const sub of recursiveSplit(text, budget, 0)) {
      chunks.push({ content: sub.trim(), index: index++, metadata });
    }
  };

  if (isJava) {
    // Extrair package e imports como contexto
    const lines = content.split('\n');
    const headerLines: string[] = [];
    let bodyStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('package ') || line.startsWith('import ') || line === '') {
        headerLines.push(lines[i]);
        bodyStart = i + 1;
      } else {
        break;
      }
    }

    const header = headerLines.join('\n');
    const body = lines.slice(bodyStart).join('\n');

    // Dividir por métodos (heurística: linhas com visibilidade + tipo + nome + parêntese)
    const methodPattern = /^(\s*)((?:public|private|protected)\s+(?:static\s+)?(?:[\w<>\[\],\s]+)\s+\w+\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{)/gm;
    const methods = splitByPattern(body, methodPattern);

    if (methods.length <= 1) {
      pushBounded(content, { language: 'java' });
    } else {
      for (const method of methods) {
        pushBounded(header + '\n\n' + method, { language: 'java' });
      }
    }
  } else if (isTS) {
    // TypeScript/TSX: dividir por export/function/class
    const tsPattern = /^(export\s+(?:default\s+)?(?:function|class|const|interface|type|enum)\s+)/gm;
    const parts = splitByPattern(content, tsPattern);

    if (parts.length <= 1) {
      pushBounded(content, { language: 'typescript' });
    } else {
      for (const part of parts) {
        pushBounded(part, { language: 'typescript' });
      }
    }
  } else {
    pushBounded(content, {});
  }

  return chunks.filter(c => c.content.length > 20);
}

/**
 * Chunking para configs: arquivo inteiro ou por seções top-level.
 */
export function chunkConfig(content: string, maxTokens: number = 256): Chunk[] {
  const budget = clampToEmbedBudget(maxTokens);
  if (estimateTokens(content) <= budget) {
    return [{ content: content.trim(), index: 0, metadata: { type: 'config' } }];
  }

  const subs = recursiveSplit(content, budget, 0);
  return subs.map((sub, i) => ({
    content: sub.trim(),
    index: i,
    metadata: { type: 'config' },
  })).filter(c => c.content.length > 10);
}

// --- Utilitários ---

interface Section {
  header: string;
  content: string;
}

function splitByHeaders(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let currentHeader = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (currentContent.length > 0) {
        sections.push({ header: currentHeader, content: currentContent.join('\n') });
      }
      currentHeader = line.replace(/^#{1,3}\s+/, '').trim();
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({ header: currentHeader, content: currentContent.join('\n') });
  }

  return sections;
}

const SPLIT_SEPARATORS = ['\n\n', '\n', '. ', ' '] as const;

/**
 * Divisão recursiva de verdade.
 *
 * A versão anterior dividia pelo primeiro separador presente no texto e
 * retornava direto, sem verificar se as partes resultantes ainda excediam o
 * limite — um parágrafo sem quebras internas passava inteiro, e o índice
 * chegou a acumular chunks de ~1 MB. Aqui, toda parte que continua acima do
 * orçamento desce para o próximo separador da escada, com corte por
 * caractere como último recurso. Invariante garantida: nenhum chunk emitido
 * excede `maxTokens` estimados.
 */
export function recursiveSplit(
  text: string,
  maxTokens: number,
  overlap: number,
  separatorIndex: number = 0,
): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  // Escada esgotada: corta por caractere. É o fallback para blobs sem
  // nenhuma estrutura (linhas gigantes, base64, minificados que escaparam).
  if (separatorIndex >= SPLIT_SEPARATORS.length) {
    const chunkSize = maxTokens * 3;
    const out: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      out.push(text.slice(i, i + chunkSize));
    }
    return out;
  }

  const sep = SPLIT_SEPARATORS[separatorIndex];
  if (!text.includes(sep)) {
    return recursiveSplit(text, maxTokens, overlap, separatorIndex + 1);
  }

  const parts = text.split(sep);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const part of parts) {
    // Uma parte sozinha acima do limite desce um nível na escada.
    if (estimateTokens(part) > maxTokens) {
      flush();
      chunks.push(...recursiveSplit(part, maxTokens, overlap, separatorIndex + 1));
      continue;
    }

    const candidate = current ? current + sep + part : part;
    if (estimateTokens(candidate) > maxTokens) {
      flush();
      const tail = overlap > 0 ? chunks[chunks.length - 1]?.slice(-overlapChars(overlap)) : '';
      current = tail ? tail + sep + part : part;
      // O overlap não pode reintroduzir estouro.
      if (estimateTokens(current) > maxTokens) current = part;
    } else {
      current = candidate;
    }
  }

  flush();
  return chunks;
}

function splitByPattern(text: string, pattern: RegExp): string[] {
  const parts: string[] = [];
  let lastIndex = 0;

  const matches = [...text.matchAll(pattern)];

  if (matches.length === 0) return [text];

  for (const match of matches) {
    if (match.index !== undefined && match.index > lastIndex) {
      const part = text.slice(lastIndex, match.index).trim();
      if (part) parts.push(part);
    }
    lastIndex = match.index ?? lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex).trim());
  }

  return parts.filter(p => p.length > 0);
}
