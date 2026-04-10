export interface Chunk {
  content: string;
  index: number;
  metadata: Record<string, unknown>;
}

/**
 * Estima tokens de forma simples (~4 caracteres por token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunking para Markdown: divide por headers, depois por tamanho
 */
export function chunkMarkdown(
  content: string,
  maxTokens: number = 512,
  overlap: number = 50
): Chunk[] {
  // Remover wikilinks para indexação, preservando o texto
  const cleaned = content.replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_match, target, _pipe, alias) => {
    return alias || target;
  });

  const sections = splitByHeaders(cleaned);
  const chunks: Chunk[] = [];
  let index = 0;

  for (const section of sections) {
    if (estimateTokens(section.content) <= maxTokens) {
      chunks.push({
        content: section.content.trim(),
        index: index++,
        metadata: { header: section.header },
      });
    } else {
      const subChunks = recursiveSplit(section.content, maxTokens, overlap);
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
 * Chunking para código: divide por funções/métodos/classes
 */
export function chunkCode(
  content: string,
  maxTokens: number = 1024,
  filePath: string = ''
): Chunk[] {
  const isJava = filePath.endsWith('.java');
  const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');

  const chunks: Chunk[] = [];
  let index = 0;

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
      // Arquivo pequeno ou sem métodos claros, tratar como chunk único
      if (estimateTokens(content) <= maxTokens) {
        chunks.push({ content: content.trim(), index: index++, metadata: { language: 'java' } });
      } else {
        const subs = recursiveSplit(content, maxTokens, 0);
        for (const sub of subs) {
          chunks.push({ content: sub.trim(), index: index++, metadata: { language: 'java' } });
        }
      }
    } else {
      for (const method of methods) {
        const fullChunk = header + '\n\n' + method;
        if (estimateTokens(fullChunk) <= maxTokens) {
          chunks.push({ content: fullChunk.trim(), index: index++, metadata: { language: 'java' } });
        } else {
          // Método muito grande, dividir
          const subs = recursiveSplit(fullChunk, maxTokens, 0);
          for (const sub of subs) {
            chunks.push({ content: sub.trim(), index: index++, metadata: { language: 'java' } });
          }
        }
      }
    }
  } else if (isTS) {
    // TypeScript/TSX: dividir por export/function/class
    const tsPattern = /^(export\s+(?:default\s+)?(?:function|class|const|interface|type|enum)\s+)/gm;
    const parts = splitByPattern(content, tsPattern);

    if (parts.length <= 1) {
      if (estimateTokens(content) <= maxTokens) {
        chunks.push({ content: content.trim(), index: index++, metadata: { language: 'typescript' } });
      } else {
        const subs = recursiveSplit(content, maxTokens, 0);
        for (const sub of subs) {
          chunks.push({ content: sub.trim(), index: index++, metadata: { language: 'typescript' } });
        }
      }
    } else {
      for (const part of parts) {
        if (estimateTokens(part) <= maxTokens) {
          chunks.push({ content: part.trim(), index: index++, metadata: { language: 'typescript' } });
        } else {
          const subs = recursiveSplit(part, maxTokens, 0);
          for (const sub of subs) {
            chunks.push({ content: sub.trim(), index: index++, metadata: { language: 'typescript' } });
          }
        }
      }
    }
  } else {
    // Fallback genérico
    if (estimateTokens(content) <= maxTokens) {
      chunks.push({ content: content.trim(), index: index++, metadata: {} });
    } else {
      const subs = recursiveSplit(content, maxTokens, 0);
      for (const sub of subs) {
        chunks.push({ content: sub.trim(), index: index++, metadata: {} });
      }
    }
  }

  return chunks.filter(c => c.content.length > 20);
}

/**
 * Chunking para configs: arquivo inteiro ou por seções top-level
 */
export function chunkConfig(content: string, maxTokens: number = 256): Chunk[] {
  if (estimateTokens(content) <= maxTokens) {
    return [{ content: content.trim(), index: 0, metadata: { type: 'config' } }];
  }

  const subs = recursiveSplit(content, maxTokens, 0);
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

function recursiveSplit(text: string, maxTokens: number, overlap: number): string[] {
  if (estimateTokens(text) <= maxTokens) {
    return [text];
  }

  const separators = ['\n\n', '\n', '. ', ' '];
  const chunks: string[] = [];
  let remaining = text;

  for (const sep of separators) {
    if (remaining.includes(sep)) {
      const parts = remaining.split(sep);
      let current = '';

      for (const part of parts) {
        const candidate = current ? current + sep + part : part;
        if (estimateTokens(candidate) > maxTokens && current) {
          chunks.push(current);
          // Overlap: manter últimos N caracteres
          const overlapChars = overlap * 4;
          current = overlapChars > 0 ? current.slice(-overlapChars) + sep + part : part;
        } else {
          current = candidate;
        }
      }

      if (current) chunks.push(current);
      return chunks;
    }
  }

  // Fallback: cortar por caractere
  const chunkSize = maxTokens * 4;
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }

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
