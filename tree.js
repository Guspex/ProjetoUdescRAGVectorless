import fs from 'node:fs/promises';
import path from 'node:path';
import { chat } from './llm.js';

const SOURCE_DIR = './instrucoes_normativas_md'; // gerado pelo converter_md.js
const TREE_FILE = './vectorless/tree.json';

const CONCURRENCY = 4; // documentos resumidos em paralelo
const MAX_BATCH_CHARS = 60_000; // tamanho máximo de cada chamada de resumo
const MAX_NODE_CHARS = 4_000; // trecho de cada seção enviado para o resumo
const SAVE_EVERY = 10; // salva o progresso a cada N documentos
const MAX_READ_CHARS = 20_000; // conteúdo máximo de cada seção lida na busca/resposta

const SUMMARY_PROMPT = `
  Você recebe as seções de um documento, cada uma com um id entre colchetes.
  Para cada id escreva um resumo de uma frase dizendo que tipo de informação a seção contém.
  Se a seção mandar consultar outra parte ou outro documento (ex: "ver Anexo B", "conforme a política de viagens"), diga isso no resumo.
  Responda somente JSON no formato: {"00001": "resumo", "00002": "resumo"}
`;

let next_id = 1;

function create_node(title, level) {
  const id = String(next_id++).padStart(5, '0');
  return { id, title, level, summary: '', text: '', children: [] };
}

// ---------------------------------------------------------------------------
// Parser dos .md gerados pelo converter_md.js
//   # título do documento, ## anexo/título, ### capítulo, #### seção,
//   ##### subseção, ###### artigo
// ---------------------------------------------------------------------------

function push_node(stack, node) {
  while (stack.at(-1).level >= node.level) stack.pop();
  stack.at(-1).children.push(node);
  stack.push(node);
}

/** @returns {{root?: object, reason?: string}} */
function parse_document(rel, content) {
  const lines = content.split(/\r?\n/);
  const title_index = lines.findIndex((line) => line.trim());
  if (title_index < 0) return { reason: 'arquivo vazio' };

  const root = create_node(lines[title_index].replace(/^#+\s*/, '').trim(), 0);
  root.file = rel;
  root.meta = {};

  const stack = [root];
  for (const line of lines.slice(title_index + 1)) {
    const source = line.match(/^<!--\s*fonte:\s*(\{.*\})\s*-->$/);
    if (source) {
      try { root.meta = JSON.parse(source[1]); } catch { /* ignora */ }
      continue;
    }
    const heading = line.match(/^(#{2,6})\s+(.*)/);
    if (!heading) {
      stack.at(-1).text += line + '\n';
      continue;
    }
    push_node(stack, create_node(heading[2].trim(), heading[1].length - 1));
  }

  for (const node of flatten(root)) node.text = node.text.trim();
  return { root };
}

// ---------------------------------------------------------------------------
// Resumos
// ---------------------------------------------------------------------------

async function summarize(root) {
  const nodes = flatten(root);
  const header = `Documento: ${root.title}\n\n`;

  // Divide em lotes para documentos grandes não estourarem o contexto
  const batches = [];
  let current = [];
  let size = 0;
  for (const node of nodes) {
    const section = `[${node.id}] ${node.title}\n${node.text.slice(0, MAX_NODE_CHARS)}`;
    if (size + section.length > MAX_BATCH_CHARS && current.length) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(section);
    size += section.length + 2;
  }
  if (current.length) batches.push(current);

  const summaries = {};
  for (const batch of batches) {
    Object.assign(summaries, await chat(SUMMARY_PROMPT, header + batch.join('\n\n'), true));
  }
  for (const node of nodes) node.summary = summaries[node.id] ?? '';
}

// ---------------------------------------------------------------------------
// Utilitários de árvore (mesma API de antes)
// ---------------------------------------------------------------------------

export function flatten(node) {
  return [node, ...node.children.flatMap(flatten)];
}

export function find_node(tree, id) {
  return flatten(tree).find((node) => node.id === id);
}

export function get_content(node) {
  const children = node.children.map(
    (child) => `${'#'.repeat(child.level + 1)} ${child.title}\n${get_content(child)}`
  );
  return [node.text, ...children].filter(Boolean).join('\n\n');
}

/** Conteúdo da seção para o contexto da LLM, cortado para documentos muito longos. */
export function read_content(node, max_chars = MAX_READ_CHARS) {
  const content = get_content(node);
  if (content.length <= max_chars) return content;
  return content.slice(0, max_chars) + '\n\n[... conteúdo cortado; leia as subseções para ver o restante]';
}

/** max_depth permite mostrar só os documentos (0) ou até capítulos (2), por exemplo. */
export function render_toc(nodes, depth = 0, max_depth = Infinity) {
  if (depth > max_depth) return '';
  return nodes
    .map(
      (node) =>
        `${'  '.repeat(depth)}[${node.id}] ${node.title} — ${node.summary}\n` +
        render_toc(node.children, depth + 1, max_depth)
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Construção da árvore
// ---------------------------------------------------------------------------

async function list_files(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await list_files(full)));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

async function run_pool(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  });
  await Promise.all(workers);
}

async function read_tree_file() {
  try {
    return JSON.parse(await fs.readFile(TREE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

let saving = Promise.resolve();
function save_tree(documents) {
  const tree = {
    title: 'Instruções Normativas UDESC',
    children: [...documents].sort((a, b) => a.file.localeCompare(b.file)),
  };
  saving = saving.then(async () => {
    await fs.mkdir(path.dirname(TREE_FILE), { recursive: true });
    const tmp = TREE_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(tree, null, 2));
    await fs.rename(tmp, TREE_FILE);
  });
  return saving.then(() => tree);
}

/**
 * Lê os .md convertidos e cria uma árvore por documento.
 * Documentos já resumidos e não modificados são reaproveitados do tree.json;
 * use { force: true } para refazer tudo.
 */
export async function build_tree({ force = false } = {}) {
  const previous = force ? null : await read_tree_file();
  const cache = new Map((previous?.children ?? []).map((doc) => [doc.file, doc]));

  // Mantém ids únicos em relação à árvore anterior
  next_id = 1;
  for (const doc of cache.values())
    for (const node of flatten(doc)) next_id = Math.max(next_id, Number(node.id) + 1);

  const files = await list_files(SOURCE_DIR);
  const documents = [];
  const skipped = [];
  let processed = 0;

  console.log(`${files.length} arquivos em ${SOURCE_DIR}`);

  await run_pool(files, CONCURRENCY, async (full_path) => {
    const rel = path.relative(SOURCE_DIR, full_path).replaceAll('\\', '/');
    const { mtimeMs } = await fs.stat(full_path);

    const cached = cache.get(rel);
    if (cached && cached.mtime === mtimeMs && cached.summarized) {
      documents.push(cached);
      return;
    }

    let root;
    try {
      const result = parse_document(rel, await fs.readFile(full_path, 'utf8'));
      if (!result.root) {
        skipped.push(`${rel}: ${result.reason}`);
        return;
      }
      root = result.root;
      root.mtime = mtimeMs;
    } catch (err) {
      skipped.push(`${rel}: erro na leitura (${err.message})`);
      return;
    }

    try {
      await summarize(root);
      root.summarized = true;
    } catch (err) {
      root.summarized = false; // será refeito na próxima execução
      console.warn(`Falha ao resumir ${rel}: ${err.message}`);
    }

    documents.push(root);
    processed++;
    console.log(`[${processed}] ${rel} — ${flatten(root).length} nós`);
    if (processed % SAVE_EVERY === 0) await save_tree(documents);
  });

  if (skipped.length) {
    console.warn(`\n${skipped.length} arquivos ignorados:`);
    for (const line of skipped) console.warn('  - ' + line);
  }

  const tree = await save_tree(documents);
  console.log(`\nÁrvore salva em ${TREE_FILE}: ${documents.length} documentos.`);
  return tree;
}

export async function load_tree() {
  return (await read_tree_file()) ?? build_tree();
}