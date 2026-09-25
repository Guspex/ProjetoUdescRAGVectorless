import { chat } from './llm.js';
import { read_content } from './tree.js';

const ANSWER_PROMPT = `
  Você é um assistente que responde dúvidas sobre as Instruções Normativas (INs) da UDESC.
  Responda em português, de forma curta e clara, usando somente o CONTEXTO.
  Ao final, cite as seções usadas no formato [id] título.
  Se a resposta não estiver no contexto, diga: "Não encontrei essa informação".
`;

/**
 * @param {string} question
 * @param {Array<object>} nodes
 * @returns {Promise<string>}
 */
export async function answer(question, nodes) {
  const context = nodes
    .map((node) => `[${node.id}] ${node.title}\n${read_content(node)}`)
    .join('\n\n');
  return chat(ANSWER_PROMPT, `CONTEXTO:\n${context}\n\nPERGUNTA: ${question}`);
}
