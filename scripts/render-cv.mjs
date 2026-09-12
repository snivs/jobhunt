#!/usr/bin/env node
// Render a CV vault note to the print-ready HTML used for PDF export.
// Usage: node scripts/render-cv.mjs "<vault note>" "<output.html>"
// The note's CV body starts after the standalone "---" separator that follows
// the "## For future agent" preamble; everything above it is agent context.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , notePath, outPath] = process.argv;
if (!notePath || !outPath) {
  console.error('usage: render-cv.mjs <note.md> <out.html>');
  process.exit(1);
}

const raw = readFileSync(notePath, 'utf8');
const withoutFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
const separator = withoutFrontmatter.indexOf('\n---\n');
if (separator === -1) throw new Error(`no CV body separator in ${notePath}`);
const body = withoutFrontmatter.slice(separator + 5).trim();

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

const out = [];
let inList = false;
const closeList = () => {
  if (inList) {
    out.push('</ul>');
    inList = false;
  }
};

for (const line of body.split(/\r?\n/)) {
  const text = line.trim();
  if (!text) {
    closeList();
    continue;
  }
  const heading = text.match(/^(#{1,3})\s+(.*)$/);
  if (heading) {
    closeList();
    out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    continue;
  }
  if (text.startsWith('- ')) {
    if (!inList) {
      out.push('<ul>');
      inList = true;
    }
    out.push(`<li>${inline(text.slice(2))}</li>`);
    continue;
  }
  closeList();
  out.push(`<p>${inline(text)}</p>`);
}
closeList();

const html = `<!doctype html><html><head><meta charset="utf-8"><title>CV</title>
<style>
  @page { size: Letter; margin: 16mm 18mm; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 10.5pt; color: #1a1a1a; line-height: 1.35; }
  h1 { font-size: 20pt; margin: 0 0 2pt 0; letter-spacing: 0.2px; }
  h1 + p { margin: 0 0 2pt 0; color: #333; }
  h2 { font-size: 12.5pt; margin: 12pt 0 4pt 0; border-bottom: 1px solid #999; padding-bottom: 2pt; text-transform: uppercase; letter-spacing: 0.6px; }
  h3 { font-size: 11pt; margin: 8pt 0 2pt 0; }
  p { margin: 0 0 4pt 0; }
  ul { margin: 0 0 4pt 0; padding-left: 16pt; }
  li { margin: 0 0 2pt 0; }
  strong { font-weight: 600; }
</style></head><body>
${out.join('\n')}
</body></html>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`${notePath} -> ${outPath} (${out.length} blocks)`);
