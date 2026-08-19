# Arquitetura da busca híbrida do kx

> Como uma consulta vira resultado, e por que cada estágio existe.
> Última atualização: 2026-08-19 (v1.1.0).

---

## O problema que a v1.0 tinha

A busca era puramente vetorial (sqlite-vec, brute force, cosseno sobre
all-MiniLM-L6-v2). Medição num índice real de 75 mil chunks:

| Consulta (termo exato do projeto) | Presente no índice | Achado no top-10? |
|---|---|---|
| `TopicRecordNameStrategy` | 21 chunks | não |
| `circuit-open` | 20 chunks | não (nem no top-50) |

Embeddings densos são ótimos para paráfrase e conceito, e comprovadamente ruins
para identificadores exatos, nomes de configuração e mensagens de erro — que é
metade do que um dev busca num corpus técnico. Um `grep` acha em milissegundos
o que o vetor não acha nunca.

Além disso, o modelo trunca em 512 tokens em silêncio. Com chunks configurados
para 1024 tokens, **51% dos chunks de código estavam parcialmente invisíveis**:
o texto existia no banco, mas nunca entrou no embedding.

## O pipeline da v1.1

```
consulta
   ├──────────────┬───────────────────┐
   │              │                   │
   v              v                   │
embedding     expressão MATCH         │
   │          (termos entre aspas)    │
   v              v                   │
sqlite-vec     FTS5/BM25              │
(top-200)      (top-200)              │
   └──────┬───────┘                   │
          v                           │
   Reciprocal Rank Fusion (k=60)      │
          v                           │
   x peso da fonte (1 + log2(w))  <───┘  .kx.json
          v
   x recência (1 + 0.3 * 2^(-idade/90d))
          v
   dedup por hash de conteúdo
          v
   top-K final
```

### Por que RRF e não normalização de scores

Distância de cosseno (0..2) e BM25 (negativo, escala dependente do corpus) são
incomensuráveis. Toda tentativa de normalizar exige constantes calibradas por
corpus. RRF ignora os valores e funde por **posição**: `score = soma de
1/(60 + rank)` em cada lista. É o método com melhor comportamento documentado
sem tuning (Cormack et al.; usado por Elasticsearch, Qdrant, Weaviate como
padrão de fusão). A Anthropic mediu na mesma família de técnica: embeddings +
BM25 com fusão reduz a taxa de falha de recuperação em 49% contra embeddings
puros.

### Por que a recência é multiplicativa e limitada

Documentação técnica envelhece: quando duas fontes cobrem o mesmo assunto, a
mais nova costuma ser a vigente (decisões de arquitetura, atas, código novo).
A literatura de freshness ranking converge para decaimento exponencial — e para
o alerta de que somar o termo temporal ao score de relevância deixa o tempo
dominar a fusão (escalas diferentes). Aqui o decaimento entra como
**multiplicador em [1, 1.3]**: desempata o par próximo a favor do recente, mas
nunca promove um resultado irrelevante só por ser novo.

- meia-vida padrão: 90 dias (`search.recency.halfLifeDays`)
- teto do impulso: +30% (`search.recency.weight`)
- desligável por projeto: `"search": { "recency": false }`

### Por que dedup por conteúdo

23% de um índice real era conteúdo byte-idêntico (documentação replicada entre
repositórios). Cada duplicata gastava uma vaga do top-K. O dedup por SHA-1 do
conteúdo mantém a cópia mais bem colocada e devolve as vagas.

### Por que o FTS5 usa external content e `remove_diacritics 2`

`content='documents'` reusa o texto que já está na tabela principal — o índice
lexical não duplica o corpus. Triggers mantêm a sincronia com qualquer
INSERT/DELETE/UPDATE. `remove_diacritics 2` faz "configuracao" casar com
"configuração", essencial num corpus PT-BR com acentuação inconsistente.
A expressão MATCH é montada com cada termo entre aspas: operadores viram
literais e nenhuma consulta do usuário quebra o parser.

## O orçamento de tokens

O truncamento silencioso do modelo é tratado na origem:

- `EMBED_SAFE_TOKENS = 440` limita qualquer chunk, independentemente da
  configuração (margem sob o limite real de 512).
- A estimativa de tokens foi recalibrada de 4 para **3 caracteres por token** —
  medição com o tokenizer real deu 2,86 chars/token em PT-BR, e menos em código.
- `recursiveSplit` agora é recursiva de verdade: parte que continua acima do
  orçamento desce a escada de separadores (parágrafo -> linha -> sentença ->
  palavra -> caractere). Invariante: nenhum chunk emitido excede o orçamento.

## Exclusões embutidas

`worktrees/`, `node_modules/`, `build/`, `target/`, `dist/`, bytecode (.class,
.jar), minificados, source maps, binários, mídia e lockfiles nunca entram no
índice — sem precisar de configuração. A checagem é por segmento **relativo à
raiz da fonte**: uma fonte apontada explicitamente para dentro de
`worktrees/x` continua indexável, porque a intenção declarada vence o padrão.
As mesmas listas alimentam o scan do indexador (nem desce nessas árvores), o
watcher e o gate central de admissão.

## Números medidos (stress com pipeline real)

Corpus sintético de 600 arquivos (300 md + 300 java + 100 arquivos de ruído em
`node_modules/` e `worktrees/`), Apple Silicon, modelo local:

| Métrica | Resultado |
|---|---|
| Indexação completa | 600 arquivos, 4.800 chunks em 68,8s (69,7 chunks/s) |
| Ruído excluído | 100 arquivos ignorados sem configuração |
| Latência de busca híbrida | p50 7 ms, p95 10 ms |
| Concorrência (8 workers) | 142 buscas/s |
| Recall@10 termo exato — vetorial pura | 3/20 |
| Recall@10 termo exato — híbrida | **20/20** |
| Reindex incremental sem mudanças | 0,1s |

## Próximos passos (fora desta versão)

Em ordem de retorno sobre esforço, com base no estado da arte de 2026:

1. **Daemon de instância única** (o `kxd` já existe para o Cockpit): um modelo
   carregado servindo N projetos por socket local, em vez de um processo por
   cliente MCP.
2. **Contextual retrieval**: prefixar cada chunk com 1-2 frases de contexto do
   documento antes de embedar (Anthropic mediu -35% de falha isolado).
3. **Reranking local**: cross-encoder ONNX pequeno sobre o top-50 (-67% de
   falha acumulado na medição da Anthropic).
4. **Chunking por AST** (tree-sitter) para Java/TS/Kotlin, com cabeçalho de
   escopo por chunk (cAST: +4,3 Recall@5).
5. **Quantização binária + rescoring** e/ou troca do modelo por
   EmbeddingGemma-300M (exige reindexação completa; espaços vetoriais são
   incompatíveis entre modelos).
