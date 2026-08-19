# Changelog

## 1.1.0 — 2026-08-19

### Busca

- **Busca híbrida**: via lexical BM25 (SQLite FTS5, external content, `remove_diacritics 2`)
  em paralelo à vetorial (sqlite-vec), fundidas por Reciprocal Rank Fusion (k=60).
  Recall de termo exato medido em stress: 3/20 na vetorial pura, 20/20 na híbrida.
- **Impulso de recência**: decaimento exponencial por meia-vida sobre o mtime
  (padrão: 90 dias, +30% no teto), como multiplicador limitado do score fundido.
  Configurável ou desligável por projeto via `search.recency`.
- **Deduplicação por conteúdo**: chunks byte-idênticos (docs replicadas entre
  repositórios) colapsam na melhor posição, liberando vagas do top-K.
- Peso de fonte (`weight`) reaplicado na fusão de forma sublinear (`1 + log2(peso)`),
  preservando a preferência por fontes canônicas sem soterrar relevância real.
- Reconciliação da denylist saiu do caminho quente da busca: roda uma vez por
  política dentro do processo (antes: varredura completa de paths a cada consulta).

### Indexação

- **Correção crítica do chunker**: a divisão recursiva agora é recursiva de fato.
  A versão anterior deixava passar chunks de até ~1 MB (um bloco sem separador
  interno era emitido inteiro).
- **Orçamento seguro de tokens**: chunks são limitados a 440 tokens estimados
  (o modelo trunca em 512 silenciosamente; 51% dos chunks de código de um índice
  real estavam truncados e inencontráveis). Estimativa recalibrada para ~3
  caracteres por token (medição real em PT-BR/código).
- **Exclusões embutidas**: `worktrees/`, `node_modules/`, artefatos de build
  (`build/`, `target/`, `dist/`, `.class`, `.jar`, minificados, source maps),
  binários, mídia e lockfiles nunca entram no índice — sem configuração. Uma
  fonte apontada explicitamente para dentro de um diretório excluído continua
  válida (a intenção declarada vence o padrão).
- **Embeddings em lote** na indexação (uma inferência por lote de 8, não por chunk).
- **Escrita transacional por arquivo**: substitui o padrão de 5 statements
  autocomitados por chunk que inflou a freelist de um índice real a 94% do arquivo.

### Operação

- Novo comando `kx vacuum`: compacta o índice, devolve espaço ao sistema de
  arquivos e ativa `auto_vacuum` incremental para a freelist não voltar a crescer.
- Migração automática: na primeira abertura de um índice antigo, o FTS5 é criado
  e populado a partir dos chunks existentes (backfill único).
