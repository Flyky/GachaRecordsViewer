import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { genshinMetadata } from '@gacha/gacha-core';
import { normalizeGithubProxy, requestPublicData } from '../src/public-data.js';
import { readDictionaryArchive } from '../src/dictionary-archive.js';
import { downloadDictionary } from '../src/metadata.js';

const proxy = 'https://proxy.example.test/', url = 'https://raw.githubusercontent.com/example/repo/main/file.json';
const signal = () => AbortSignal.timeout(5000);
function archive(incomplete = false, directories = false) {
  const files: Buffer[] = [];
  const add = (path: string, data: Buffer, type = 48) => {
    const header = Buffer.alloc(512); header.write(path); header.write(data.length.toString(8).padStart(11, '0'), 124);
    header.fill(32, 148, 156); header[156] = type;
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    files.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  };
  for (const [language, locale] of [['ChineseSimplified', 'zh-cn'], ['English', 'en-us']]) for (const itemType of ['character', 'weapon']) {
    const directory = `repo-main/src/data/${language}/${itemType === 'character' ? 'characters' : 'weapons'}/`;
    if (directories) add(directory, Buffer.alloc(0), 53);
    for (const item of genshinMetadata.all().filter((item) => item.itemType === itemType)) {
      add(directory + item.id + '.json', Buffer.from(JSON.stringify({ id: Number(item.id), name: item.names[locale!], rarity: item.rank })));
    }
  }
  if (directories) add('repo-main/src/data/French/unneeded.bin', randomBytes(256 * 1024));
  if (!incomplete) files.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(files));
}

it('normalizes optional HTTPS prefixes and rejects credentials, query strings and local addresses', () => {
  expect(normalizeGithubProxy('  ')).toBe('');
  expect(normalizeGithubProxy(' https://proxy.example.test/gh ')).toBe('https://proxy.example.test/gh/');
  for (const input of ['http://proxy.example.test', 'https://user:pass@proxy.example.test/', 'https://proxy.example.test/?token=x', 'https://proxy.example.test/#x', 'https://127.0.0.1', 'https://[::1]', 'https://x.local/']) expect(() => normalizeGithubProxy(input)).toThrow();
});

it('uses direct success without contacting a proxy and retries invalid public responses through the prefix', async () => {
  const calls: string[] = [], read = async (response: Response) => response.json() as Promise<{ ok: boolean }>;
  let direct = true;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input)); expect(init?.redirect).toBe('error'); expect(init?.headers).not.toHaveProperty('Cookie');
    return new Response(direct || String(input).startsWith(proxy) ? '{"ok":true}' : '<html>blocked</html>');
  };
  expect(await requestPublicData(url, read, { fetch: fetcher, signal: signal(), proxy })).toEqual({ ok: true });
  expect(calls).toEqual([url]); calls.length = 0; direct = false;
  expect(await requestPublicData(url, read, { fetch: fetcher, signal: signal(), proxy })).toEqual({ ok: true });
  expect(calls).toEqual([url, proxy + url]);
});

it('falls back after a direct timeout, but never retries after the whole refresh is aborted', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input)); if (String(input).startsWith(proxy)) return new Response('ok');
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  };
  expect(await requestPublicData(url, (response) => response.text(), { fetch: fetcher, signal: signal(), proxy, directTimeoutMs: 5 })).toBe('ok');
  const controller = new AbortController(); calls.length = 0;
  const pending = requestPublicData(url, (response) => response.text(), { fetch: fetcher, signal: controller.signal, proxy }); controller.abort();
  await expect(pending).rejects.toThrow(); expect(calls).toEqual([url]);
});

it('reads dictionary files from a bounded archive and rejects HTML or incomplete archives', async () => {
  const pages = await readDictionaryArchive(new Response(archive()));
  expect(pages).toHaveLength(4); expect(pages.reduce((sum, page) => sum + page.rows.length, 0)).toBe(genshinMetadata.size * 2);
  await expect(readDictionaryArchive(new Response('<html>blocked</html>'))).rejects.toThrow();
  await expect(readDictionaryArchive(new Response(archive(true)))).rejects.toThrow();
});

it('stops the archive download after both locale subtrees and cancels the unused body', async () => {
  const data = archive(false, true); let offset = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) { controller.close(); return; }
      controller.enqueue(data.subarray(offset, offset + 1024)); offset += 1024;
    },
    cancel() { cancelled = true; },
  });
  const pages = await readDictionaryArchive(new Response(body));
  expect(pages.reduce((sum, page) => sum + page.rows.length, 0)).toBe(genshinMetadata.size * 2);
  expect(offset).toBeLessThan(data.length / 2); expect(cancelled).toBe(true);
});

it('keeps Vercel URLs out of GHProxy, falling back to the same project archive with both locales', async () => {
  const calls: string[] = [], data = archive();
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    if (String(input).startsWith(proxy)) return new Response(data);
    throw new Error('direct network blocked');
  };
  const snapshot = await downloadDictionary(fetcher, signal(), Date.now(), proxy);
  expect(snapshot.items).toEqual(genshinMetadata.all()); expect(snapshot.source.name).toBe('genshin-db-github');
  expect(calls).toHaveLength(6);
  expect(calls.at(-1)).toBe(proxy + 'https://github.com/theBowja/genshin-db/archive/refs/heads/main.tar.gz');
  expect(calls.some((value) => value.startsWith(proxy + 'https://genshin-db-api'))).toBe(false);
});
