import { build_tree, load_tree, render_toc } from './tree.js';
import { search } from './search.js';
import { answer } from './answer.js';

const args = process.argv.slice(2);

if (args[0] === '--index') {
  const tree = await build_tree();
  console.info(render_toc(tree.children, 0, 0)); // só os documentos; o sumário completo é enorme
} else {
  const question = args.join(' ');
  const tree = await load_tree();
  const nodes = await search(tree, question);

  console.info('\nRESPOSTA:\n' + (await answer(question, nodes)));
}
