'use strict';

// Read-only navigation over available documentation; never prints env/config files.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'Dokumentasi');
const args = process.argv.slice(2);
const usage = 'Usage: node scripts/docs-context.cjs --list | --outline <file> | --find <text> [--file <path>] [--limit 1..200] | --check';

function fail(message) { console.error(message); process.exit(1); }
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name))
      : e.isFile() && e.name.endsWith('.md') ? [path.join(dir, e.name)] : []);
}
function git(command) {
  return execFileSync('git', command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function load(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  let fence = null;
  const headings = [];
  const contexts = [];
  let context = '(tanpa heading)';
  lines.forEach((line, i) => {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (f && !fence) fence = { char: f[1][0], length: f[1].length };
    else if (f && fence && f[1][0] === fence.char && f[1].length >= fence.length && !f[2].trim()) fence = null;
    else if (!fence) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) { context = h[2]; headings.push({ line: i + 1, depth: h[1].length, text: h[2] }); }
    }
    contexts[i] = context;
  });
  return { file, name: path.relative(docs, file).replace(/\\/g, '/'), lines, headings, contexts };
}

try {
  const mode = args.shift();
  if (!['--list', '--outline', '--find', '--check'].includes(mode)) fail(usage);
  const query = ['--outline', '--find'].includes(mode) ? args.shift() : null;
  if (query != null && (!query.trim() || query.startsWith('--'))) fail(usage);
  if (['--outline', '--find'].includes(mode) && query == null) fail(usage);
  let filter = '', limit = 30;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (mode !== '--find' || value == null) fail(usage);
    if (flag === '--file' && value.trim() && !value.startsWith('--')) filter = value.replace(/\\/g, '/');
    else if (flag === '--limit' && /^\d+$/.test(value) && +value >= 1 && +value <= 200) limit = +value;
    else fail(usage);
  }
  const entries = walk(docs).map(load);
  if (mode === '--list') {
    const tracked = new Set(git(['ls-files', '-z', '--', 'Dokumentasi']).split('\0'));
    for (const d of entries) {
      const rel = 'Dokumentasi/' + d.name;
      let status = tracked.has(rel) ? 'dilacak Git' : 'belum dilacak';
      if (!tracked.has(rel)) {
        try { git(['check-ignore', '-q', '--', rel]); status = 'lokal (diabaikan Git)'; }
        catch (e) { if (e.status !== 1) throw e; }
      }
      console.log(`${rel} | ${d.lines.length} baris | ${fs.statSync(d.file).size} byte | ${status}`);
    }
  } else if (mode === '--outline') {
    const matches = entries.filter(d => d.name === query.replace(/\\/g, '/'));
    if (matches.length !== 1) fail('File tidak tersedia. Gunakan path relatif terhadap Dokumentasi/; lihat --list.');
    for (const h of matches[0].headings.filter(h => h.depth <= 2)) console.log(`Dokumentasi/${matches[0].name}:${h.line}: ${'#'.repeat(h.depth)} ${h.text}`);
  } else if (mode === '--find') {
    const matches = entries.filter(d => d.name.toLowerCase().includes(filter.toLowerCase()));
    if (!matches.length) fail('Tidak ada file yang cocok dengan --file.');
    let count = 0;
    for (const d of matches) d.lines.forEach((line, i) => {
      if (!line.toLowerCase().includes(query.toLowerCase())) return;
      if (count++ < limit) console.log(`Dokumentasi/${d.name}:${i + 1} [${d.contexts[i]}]\n  ${line.length > 500 ? line.slice(0, 500) + ' [baris dipotong]' : line}`);
    });
    console.log(`${count} baris cocok; ${Math.min(count, limit)} ditampilkan.`);
  } else {
    const errors = [];
    for (const d of entries) {
      const header = d.lines.slice(0, 30).join('\n');
      for (const required of ['ATURAN FILE INI', 'TUJUAN', 'BOLEH', 'DILARANG', 'FORMAT']) {
        if (!header.includes(required)) errors.push(`${d.name}: header ${required} tidak ada.`);
      }
    }
    const linkOwners = ['README.md', 'ringkasan_rapat_auto_entry_cme.md'];
    for (const name of linkOwners) {
      const d = entries.find(d => d.name === name);
      if (!d) { errors.push(`${name}: file navigasi tidak ada.`); continue; }
      for (const match of d.lines.join('\n').matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z\d+.-]*:|^#/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(d.file), decodeURIComponent(target.split('#')[0]));
        if (!fs.existsSync(resolved)) errors.push(`${name}: tautan hilang ${target}`);
      }
    }
    if (errors.length) fail(errors.join('\n'));
    console.log(`Lulus: header ${entries.length} dokumen dan tautan relatif ${linkOwners.length} file navigasi. Isi historis/produksi tidak divalidasi.`);
  }
} catch (e) { fail(e.message); }
