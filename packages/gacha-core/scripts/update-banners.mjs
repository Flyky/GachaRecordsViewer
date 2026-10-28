import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import ts from 'typescript';

// Read only literal AST fields; never evaluate downloaded JavaScript.
const base = 'https://raw.githubusercontent.com/MadeBaruna/paimon-moe/';
async function download(url) {
  const response = await fetch(url, { signal: globalThis.AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Banner source returned ${response.status}`);
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('Banner source too large');
  return text;
}
const api = await download('https://api.github.com/repos/MadeBaruna/paimon-moe/commits?path=src/data/banners.js&per_page=1');
const revision = JSON.parse(api)[0]?.sha;
if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Missing source revision');
const sourceUrl = `${base}${revision}/src/data/banners.js`;
const [source, license] = await Promise.all([download(sourceUrl), download(`${base}${revision}/LICENSE`)]);
if (!license.includes('MIT License') || !license.includes('Copyright (c) 2021 Made Baruna')) throw new Error('Unexpected source license');
const ast = ts.createSourceFile('banners.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
if (ast.parseDiagnostics.length) throw new Error('Invalid banner source');
let object;
for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.getText(ast) === 'banners' && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) object = declaration.initializer;
  }
}
const field = (node, key) => node?.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(ast) === key)?.initializer;
const string = (node) => { if (!node || !ts.isStringLiteral(node)) throw new Error('Expected banner string'); return node.text; };
const flag = (node) => { if (node === undefined) return false; if (node.kind !== ts.SyntaxKind.TrueKeyword && node.kind !== ts.SyntaxKind.FalseKeyword) throw new Error('Expected banner flag'); return node.kind === ts.SyntaxKind.TrueKeyword; };
const characters = field(object, 'characters');
if (!characters || !ts.isArrayLiteralExpression(characters)) throw new Error('Missing character banners');
const catalog = JSON.parse(await readFile(new URL('../src/catalog/genshin-items.json', import.meta.url), 'utf8'));
const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const ids = new Map(catalog.items.filter((item) => item.itemType === 'character' && item.rank === 5).map((item) => [normalize(item.names['en-us']), item.id]));
const entries = characters.elements.map((node) => {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Expected literal banner');
  const start = string(field(node, 'start')), end = string(field(node, 'end')), featured = field(node, 'featured');
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(start) || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(end) || start >= end || !featured || !ts.isArrayLiteralExpression(featured)) throw new Error('Invalid banner range');
  const itemIds = featured.elements.map((item) => {
    const slug = string(item), id = ids.get(normalize(slug));
    if (!id) throw new Error(`Unknown banner character: ${slug}. Update item metadata first.`);
    return id;
  });
  if (!itemIds.length) throw new Error('Empty featured list');
  return { start, end, startGlobal: flag(field(node, 'timezoneDependent')), endGlobal: flag(field(node, 'timezoneDependentEnd')), itemIds: [...new Set(itemIds)] };
});
if (entries.length < 100) throw new Error('Incomplete banner source');
const snapshot = { source: { name: 'paimon-moe', revision, url: sourceUrl, license: 'MIT', retrievedAt: new Date().toISOString(), sha256: createHash('sha256').update(source).digest('hex') }, entries };
await writeFile(new URL('../src/catalog/character-banners.json', import.meta.url), JSON.stringify(snapshot, null, 2) + '\n');
await writeFile(new URL('../BANNERS_LICENSE', import.meta.url), license);
console.log(`Saved ${entries.length} character banner periods, ${entries[0].start} to ${entries.at(-1).end}.`);
