#!/usr/bin/env node
/**
 * Converte as Instruções Normativas baixadas (.pdf, .docx) para Markdown,
 * reconstruindo a estrutura da norma como cabeçalhos:
 *
 *   #      Título do documento (do manifesto.csv)
 *   ##     ANEXO / TÍTULO
 *   ###    CAPÍTULO
 *   ####   Seção
 *   #####  Subseção
 *   ###### Art. Nº
 *
 * Uso:
 *   npm i unpdf mammoth turndown turndown-plugin-gfm
 *   node converter_md.js
 *   node converter_md.js --entrada ./instrucoes_normativas_udesc --saida ./instrucoes_normativas_md
 *
 * Opções:
 *   --force     reconverte mesmo o que já está atualizado
 *   --ocr       roda `ocrmypdf` em PDFs escaneados (precisa estar instalado)
 *   --soffice   converte .doc/.xls/.xlsx/.odt/.ods via LibreOffice (precisa do `soffice`)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const exec = promisify(execFile);

const args = parse_args(process.argv.slice(2));
const SOURCE_DIR = args.entrada ?? './instrucoes_normativas_udesc';
const OUTPUT_DIR = args.saida ?? './instrucoes_normativas_md';
const MANIFEST_FILE = path.join(SOURCE_DIR, 'manifesto.csv');
const MIN_PDF_CHARS = 200;

const SOFFICE_EXT = new Set(['.doc', '.xls', '.xlsx', '.odt', '.ods', '.rtf']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// ---------------------------------------------------------------------------
// Estrutura da norma
// ---------------------------------------------------------------------------

const ROMAN = '[IVXLCDM]+';
// "ANEXO II – TÍTULO", mas não referências no texto ("ANEXO III, desta Instrução...")
const ANEXO = {
  test(s) {
    const m = s.match(/^ANEXO(\s+(?:[IVXLCDM]+|ÚNICO))?(?![A-Za-zÀ-ú])(.*)$/s);
    return !!m && !/^\s*[,;.]|^\s+[a-zà-ú]/.test(m[2]);
  },
};
const HEADINGS = [
  { depth: 2, re: ANEXO },
  { depth: 2, re: new RegExp(`^T[ÍI]TULO\\s+${ROMAN}\\b`) },
  { depth: 3, re: new RegExp(`^CAP[ÍI]TULO\\s+${ROMAN}\\b`, 'i') },
  { depth: 4, re: new RegExp(`^SE[ÇC][ÃA]O\\s+(${ROMAN}|ÚNICA)\\b`, 'i') },
  { depth: 5, re: new RegExp(`^SUBSE[ÇC][ÃA]O\\s+${ROMAN}\\b`, 'i') },
];
const ARTICLE = /^Art\s*\.?\s*(\d+)\s*(?:º|°|o)?\s*\.?\s*[-–]?\s*(.*)$/s;

// Carimbos de assinatura digital (SGP-e e DOE/SC) que o PDF intercala no meio do texto
const STAMPS = [
  /P[áa]g\.\s*\d+\s*de\s*\d+\s*-\s*Documento assinado digitalmente\.\s*Para confer[êe]ncia,\s*acesse o site\s*https?:\/\/\s*\S*sgpe\.sea\.sc\.gov\.br\/\S*\s*e informe o processo\s*[A-Z]+\s*[\d./-]+\s*e o c[óo]digo\s*[A-Z0-9]+\.?/g,
  /Para verificar a autenticidade desta c[óo]pia impressa,\s*acesse o site\s*https?:\/\/\s*\S*sgpe\.sea\.sc\.gov\.br\/\S*\s*e informe o processo\s*[A-Z]+\s*[\d./-]+\s*e o c[óo]digo\s*[A-Z0-9]+\.?/g,
  /O original deste documento [ée] eletr[ôo]nico e foi assinado utilizando Assinatura Digital[\s\S]{0,300}?\s*em\s*\d{2}\/\d{2}\/\d{4}\s*[àa]s\s*\d{2}:\d{2}:\d{2}(,\s*conforme Decreto Estadual n[ºo°]\s*\d+,\s*de \d+ de \w+ de \d{4})?\.?/g,
  /Di[áa]rio Oficial Eletr[ôo]nico de Santa Catarina\.\s*Documento assinado digitalmente conforme MP[\s\S]{0,250}?www\.doe\.sea\.sc\.gov\.br\.?/g,
];
// Troca o carimbo por uma única quebra de linha, sem deixar linha vazia (que partiria o parágrafo)
const strip_stamps = (s) =>
  STAMPS.reduce((acc, re) => acc.replace(re, ''), s).replace(/[ \t]*\n?(\s*)+\n?/g, '\n');
const ARTICLE_DEPTH = 6;

// Linhas que sempre começam um novo parágrafo (parágrafos, incisos, alíneas, listas)
const NEW_PARAGRAPH = /^(§\s*\d+|Par[áa]grafo [úu]nico|[IVXLCDM]+\s*[-–—]\s|[a-z]\)\s|\d+(\.\d+)*[.)]\s|[•▪◦●\-*]\s)/;
const PAGE_NUMBER = /^(p[áa]g(ina)?\.?\s*)?\d+(\s*(de|\/)\s*\d+)?$/i;

const plain = (s) => s.replace(/\*\*|__/g, '').trim();
const heading_of = (s) => {
  const t = plain(s);
  return t.length < 150 && HEADINGS.find((h) => h.re.test(t));
};
const is_caps = (s) => /[A-ZÀ-Ý]{3}/.test(s) && s === s.toUpperCase();
const is_title_line = (s) => {
  const t = plain(s);
  return t.length < 150 && (is_caps(t) || (/^D[aeo]s?\s/.test(t) && !/[.;:,]$/.test(t)));
};

/**
 * Só conta como início de artigo se a numeração for a próxima esperada, o que evita
 * confundir com citações ("Art. 5º da Lei ..."). Depois de um ANEXO a numeração pode
 * recomeçar em Art. 1, sem perder a sequência caso o "ANEXO" seja só uma referência.
 */
function article_counter() {
  let last = 0;
  let after_anexo = false;
  return (line) => {
    const t = plain(line);
    if (ANEXO.test(t)) after_anexo = true;
    const m = t.match(ARTICLE);
    const n = m ? Number(m[1]) : 0;
    if (m && ((n > last && n <= last + 3) || (after_anexo && n === 1))) {
      last = n;
      after_anexo = false;
      return m;
    }
    return null;
  };
}

/** Junta as linhas quebradas do PDF em parágrafos. */
function join_lines(lines) {
  const paragraphs = [];
  let current = '';
  const is_next_article = article_counter();
  const flush = () => {
    if (current) paragraphs.push(current);
    current = '';
  };

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    // avaliado sempre, fora do ||, para o contador não perder artigos
    const article = is_next_article(line);
    const starts_new =
      article ||
      !current ||
      heading_of(current) ||
      heading_of(line) ||
      NEW_PARAGRAPH.test(line) ||
      /[.:;!?]$/.test(current) ||
      is_caps(line) !== is_caps(current);

    if (starts_new) {
      flush();
      current = line;
    } else if (/[a-zà-ú]-$/.test(current) && /^[a-zà-ú]/.test(line)) {
      current = current.slice(0, -1) + line; // palavra hifenizada na quebra
    } else {
      current += ' ' + line;
    }
  }
  flush();
  return paragraphs;
}

/** Transforma parágrafos em Markdown, marcando títulos, capítulos, seções e artigos. */
function structure(paragraphs) {
  const out = [];
  const next_article = article_counter();

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];

    // Cabeçalho que já veio do Word: rebaixa um nível (o # é o título do documento)
    if (/^#{1,6}\s/.test(p)) {
      out.push(p.startsWith('######') ? p : '#' + p);
      continue;
    }
    // Tabelas e listas passam direto
    if (/^(\||-\s|\d+\.\s)/.test(p)) {
      out.push(p);
      continue;
    }

    const text = plain(p);

    const art = next_article(p);
    if (art) {
      out.push(`${'#'.repeat(ARTICLE_DEPTH)} Art. ${Number(art[1])}º`);
      if (art[2].trim()) out.push(art[2].trim());
      continue;
    }

    const heading = heading_of(p);
    if (heading) {
      let title = text;
      const next = paragraphs[i + 1];
      if (next && is_title_line(next) && !heading_of(next) && !ARTICLE.test(plain(next))) {
        title += ' — ' + plain(next);
        i++;
      }
      out.push(`${'#'.repeat(heading.depth)} ${title}`);
      continue;
    }

    out.push(p);
  }
  return out.join('\n\n');
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function pdf_to_paragraphs(file) {
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
  const { text: pages } = await extractText(pdf, { mergePages: false });

  let page_lines = pages.map((page) =>
    strip_stamps(page)
      .split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim())
  );

  // Página de assinaturas do SGPe: descarta do cabeçalho "Assinaturas do documento" até o fim da página
  page_lines = page_lines.map((lines) => {
    const idx = lines.findIndex((l) => /^Assinaturas do documento/i.test(l));
    return idx >= 0 ? lines.slice(0, idx) : lines;
  });

  // Cabeçalhos/rodapés: linhas (ignorando números) que se repetem na maioria das páginas
  const key = (l) => l.replace(/\d+/g, '#').toLowerCase();
  const repeated = new Set();
  if (page_lines.length >= 2) {
    const count = new Map();
    for (const lines of page_lines)
      for (const k of new Set(lines.filter(Boolean).map(key))) count.set(k, (count.get(k) ?? 0) + 1);
    const threshold = Math.max(2, Math.ceil(page_lines.length * 0.6));
    for (const [k, c] of count) if (c >= threshold && k.length < 250) repeated.add(k);
  }

  const lines = page_lines
    .flat()
    .filter((l) => !l || (!repeated.has(key(l)) && !PAGE_NUMBER.test(l)));

  const chars = lines.join('').length;
  return { paragraphs: join_lines(lines), chars };
}

async function run_ocr(file) {
  const out = path.join(os.tmpdir(), `ocr_${Date.now()}_${path.basename(file)}`);
  await exec('ocrmypdf', ['--skip-text', '-l', 'por', '--quiet', file, out], { timeout: 600_000 });
  return out;
}

// ---------------------------------------------------------------------------
// DOCX / HTML
// ---------------------------------------------------------------------------

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
turndown.use(gfm);
turndown.remove(['img', 'style', 'script', 'head']);

/**
 * Prepara tabelas para o plugin gfm:
 * - remove <colgroup>/<col> (o LibreOffice gera, e o plugin deixa a tabela em HTML)
 * - achata o conteúdo das células numa linha só (<p> e <br> quebrariam a tabela)
 * - promove a 1ª linha a cabeçalho (<th>), que o Word raramente marca
 */
function prepare_tables(html) {
  html = html
    .replace(/<colgroup\b[\s\S]*?<\/colgroup>/gi, '')
    .replace(/<col\b[^>]*>/gi, '')
    .replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_, tag, attrs, inner) => {
      const flat = inner
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/?(p|div|span)\b[^>]*>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `<${tag}${attrs}>${flat}</${tag}>`;
    });
  return html.replace(/(<table\b[\s\S]*?<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/gi, (_, open, cells, close) =>
    open + cells.replace(/<td\b/gi, '<th').replace(/<\/td>/gi, '</th>') + close
  );
}

function html_to_paragraphs(html) {
  const md = turndown.turndown(prepare_tables(html));
  return md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

async function docx_to_paragraphs(file) {
  const { value: html } = await mammoth.convertToHtml(
    { path: file },
    { convertImage: mammoth.images.imgElement(() => ({ src: '' })) }
  );
  return html_to_paragraphs(html);
}

async function soffice_to_paragraphs(file) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'soffice_'));
  try {
    await exec('soffice', ['--headless', '--convert-to', 'html', '--outdir', tmp, file], {
      timeout: 180_000,
    });
    const html_file = (await fs.readdir(tmp)).find((f) => f.endsWith('.html'));
    if (!html_file) throw new Error('LibreOffice não gerou HTML');
    return html_to_paragraphs(await fs.readFile(path.join(tmp, html_file), 'utf8'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Manifesto (gerado pelo baixar_ins_udesc.py)
// ---------------------------------------------------------------------------

function parse_csv(content, sep = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  content = content.replace(/^\uFEFF/, '');
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function load_manifest() {
  try {
    const [header, ...rows] = parse_csv(await fs.readFile(MANIFEST_FILE, 'utf8'));
    return new Map(
      rows.map((r) => {
        const e = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
        return [e.arquivo.replaceAll('\\', '/'), e];
      })
    );
  } catch {
    console.warn('manifesto.csv não encontrado, títulos virão do nome do arquivo.');
    return new Map();
  }
}

function document_title(rel, meta) {
  if (!meta?.in) return path.basename(rel, path.extname(rel)).replace(/_/g, ' ');
  const label = meta.in.replace(/^IN_(\d{3})_(\d{4})_?/, 'IN $1/$2 ').replace(/_/g, ' ').trim();
  const desc = (meta.descricao ?? '').replace(/\s+/g, ' ').slice(0, 200);
  return meta.tipo === 'anexo' ? `${label} — Anexo: ${desc}` : `${label} — ${desc}`;
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

function parse_args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/);
    if (!m) continue;
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
    else out[m[1]] = true;
  }
  return out;
}

async function list_files(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await list_files(full)));
    else if (entry.name !== 'manifesto.csv' && !entry.name.endsWith('.part')) out.push(full);
  }
  return out.sort();
}

async function is_up_to_date(src, dest) {
  try {
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    return d.mtimeMs >= s.mtimeMs;
  } catch {
    return false;
  }
}

async function convert(file, rel, meta) {
  const ext = path.extname(file).toLowerCase();
  let paragraphs;

  if (ext === '.pdf') {
    let result = await pdf_to_paragraphs(file);
    if (result.chars < MIN_PDF_CHARS) {
      if (!args.ocr) return { status: 'escaneado', detail: 'sem texto; rode com --ocr' };
      const ocr_file = await run_ocr(file);
      try {
        result = await pdf_to_paragraphs(ocr_file);
      } finally {
        await fs.rm(ocr_file, { force: true });
      }
      if (result.chars < MIN_PDF_CHARS) return { status: 'escaneado', detail: 'OCR sem resultado' };
    }
    paragraphs = result.paragraphs;
  } else if (ext === '.docx') {
    paragraphs = await docx_to_paragraphs(file);
  } else if (SOFFICE_EXT.has(ext)) {
    if (!args.soffice) return { status: 'ignorado', detail: `${ext}: rode com --soffice` };
    paragraphs = await soffice_to_paragraphs(file);
  } else if (IMAGE_EXT.has(ext)) {
    return { status: 'ignorado', detail: 'imagem' };
  } else {
    return { status: 'ignorado', detail: `formato ${ext}` };
  }

  if (!paragraphs.length) return { status: 'vazio', detail: '' };

  const source = {
    arquivo: rel,
    ano: meta?.ano ?? rel.split('/')[0],
    in: meta?.in ?? '',
    tipo: meta?.tipo ?? '',
    url: meta?.url ?? '',
  };
  const markdown =
    `# ${document_title(rel, meta)}\n\n` +
    `<!-- fonte: ${JSON.stringify(source)} -->\n\n` +
    structure(paragraphs) +
    '\n';
  return { status: 'ok', markdown };
}

async function main() {
  const manifest = await load_manifest();
  const files = await list_files(SOURCE_DIR);
  const used = new Set();
  const report = [];

  console.log(`${files.length} arquivos em ${SOURCE_DIR}\n`);

  for (const [i, file] of files.entries()) {
    const rel = path.relative(SOURCE_DIR, file).replaceAll('\\', '/');

    // mesmo nome com extensões diferentes (x.pdf e x.docx) não se sobrescrevem
    let out_rel = rel.replace(/\.[^./]+$/, '.md');
    if (used.has(out_rel)) out_rel = rel + '.md';
    used.add(out_rel);
    const dest = path.join(OUTPUT_DIR, out_rel);

    let result;
    if (!args.force && (await is_up_to_date(file, dest))) {
      result = { status: 'atualizado', detail: '' };
    } else {
      try {
        result = await convert(file, rel, manifest.get(rel));
        if (result.markdown) {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, result.markdown);
          result.detail = `${result.markdown.length} caracteres`;
        }
      } catch (err) {
        result = { status: 'erro', detail: err.message };
      }
    }

    console.log(`[${i + 1}/${files.length}] ${result.status.padEnd(10)} ${rel} ${result.detail ?? ''}`);
    report.push([rel, out_rel, result.status, result.detail ?? '']);
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const csv = [['origem', 'markdown', 'status', 'detalhe'], ...report]
    .map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(';'))
    .join('\n');
  await fs.writeFile(path.join(OUTPUT_DIR, 'conversao.csv'), '\uFEFF' + csv);

  const totals = report.reduce((acc, r) => ((acc[r[2]] = (acc[r[2]] ?? 0) + 1), acc), {});
  console.log('\nResumo:', totals);
  console.log(`Relatório em ${path.join(OUTPUT_DIR, 'conversao.csv')}`);
}

main();