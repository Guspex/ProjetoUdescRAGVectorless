import { chat } from './llm.js';
import { find_node, read_content, render_toc } from './tree.js';

const SEARCH_PROMPT = `
  Você é um especialista em encontrar informações nas Instruções Normativas (INs) da UDESC.
  Você recebe:
  - DOCUMENTOS: a lista de todas as INs e anexos (ids, títulos e resumos);
  - ESTRUTURA: as seções (títulos, capítulos, artigos) dos documentos que você já abriu;
  - a PERGUNTA do usuário e o que já foi LIDO.
  Trabalhe como um humano consultando o índice de um livro:
  - use "open_ids" com ids de DOCUMENTOS para ver a estrutura deles;
  - use "node_ids" com ids de seções da ESTRUTURA para ler o conteúdo;
  - se o conteúdo lido mandar consultar outra seção, anexo ou IN, vá atrás dela;
  - quando houver versões de anos diferentes, prefira a IN mais recente.
  Use "done": true quando o que já foi lido for suficiente para responder.
  Responda somente JSON no formato: {"reasoning": "...", "open_ids": ["00001"], "node_ids": ["00002"], "done": false}
`;

const as_ids = (value) => (Array.isArray(value) ? value.map(String) : []);

/**
 * @param {object} tree
 * @param {string} question
 * @param {number} max_steps
 */
export async function search(tree, question, max_steps = 4) {
  const documents = render_toc(tree.children, 0, 0);
  const opened = [];
  const read = [];

  for (let step = 1; step <= max_steps; step++) {
    const structure = opened.map((doc) => render_toc([doc])).join('\n') || 'nenhum documento aberto';
    const read_text =
      read.map((node) => `[${node.id}] ${node.title}\n${read_content(node)}`).join('\n\n') ||
      'nada ainda';

    const decision = await chat(
      SEARCH_PROMPT,
      `DOCUMENTOS:\n${documents}\nESTRUTURA:\n${structure}\n\nPERGUNTA: ${question}\n\nLIDO:\n${read_text}`,
      true
    );

    console.info(`\n[passo ${step}] ${decision.reasoning}`);

    const new_docs = as_ids(decision.open_ids)
      .filter((id) => !opened.some((doc) => doc.id === id))
      .map((id) => tree.children.find((doc) => doc.id === id))
      .filter(Boolean);

    const new_nodes = as_ids(decision.node_ids)
      .filter((id) => !read.some((node) => node.id === id))
      .map((id) => find_node(tree, id))
      .filter(Boolean);

    if (decision.done || (!new_docs.length && !new_nodes.length)) break;

    new_docs.forEach((doc) => console.info(`  -> abrindo [${doc.id}] ${doc.title}`));
    new_nodes.forEach((node) => console.info(`  -> lendo [${node.id}] ${node.title}`));
    opened.push(...new_docs);
    read.push(...new_nodes);
  }

  return read;
}
