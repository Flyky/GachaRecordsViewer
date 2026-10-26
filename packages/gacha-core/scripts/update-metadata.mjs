import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import genshin from 'genshin-db';

const require = createRequire(import.meta.url);
const version = require('genshin-db/package.json').version;
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (manifest.devDependencies['genshin-db'] !== version) throw new Error('Metadata source must match the pinned package version.');
const items = new Map();
for (const [folder, itemType] of [['characters', 'character'], ['weapons', 'weapon']]) {
  for (const [language, locale] of [['ChineseSimplified', 'zh-cn'], ['English', 'en-us']]) {
    const rows = genshin[folder]('names', { matchCategories: true, verboseCategories: true, resultLanguage: language });
    if (!Array.isArray(rows) || !rows.length) throw new Error('Empty metadata source.');
    for (const row of rows) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isInteger(row.rarity)) throw new Error('Unexpected source ID or rarity.');
      if (![3, 4, 5].includes(row.rarity)) continue;
      if (typeof row.name !== 'string' || !row.name.trim()) throw new Error('Missing source name.');
      const id = String(row.id);
      const item = items.get(id) ?? { id, itemType, rank: row.rarity, names: {} };
      if (item.itemType !== itemType || item.rank !== row.rarity || item.names[locale]) throw new Error('Conflicting source metadata.');
      item.names[locale] = row.name; items.set(id, item);
    }
  }
}
const snapshot = { schemaVersion: 1, game: 'hk4e', source: {
  name: 'genshin-db', version, url: 'https://github.com/theBowja/genshin-db', license: 'MIT', retrievedAt: new Date().toISOString(),
}, items: [...items.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id, 'en')) };
if (snapshot.items.length < 100 || snapshot.items.some((item) => !item.names['zh-cn'] || !item.names['en-us'])) throw new Error('Incomplete metadata source.');
const target = fileURLToPath(new URL('../src/catalog/genshin-items.json', import.meta.url));
await mkdir(dirname(target), { recursive: true });
await writeFile(`${target}.tmp`, JSON.stringify(snapshot, null, 2) + '\n');
await rename(`${target}.tmp`, target);
const license = await readFile(require.resolve('genshin-db/LICENSE'), 'utf8');
await writeFile(new URL('../METADATA_LICENSE', import.meta.url), license);
console.log(`Generated ${snapshot.items.length} items from genshin-db@${version}. Review the diff before committing.`);
