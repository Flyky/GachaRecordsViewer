import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';

export type DictionaryPage = { folder: 'characters' | 'weapons'; language: 'ChineseSimplified' | 'English'; rows: Record<string, unknown>[] };

// Read selected JSON files from a bounded tar.gz stream; never extract paths or execute repository code.
export async function readDictionaryArchive(response: Response): Promise<DictionaryPage[]> {
  if (!response.ok || !response.body) throw new Error('Dictionary archive unavailable');
  const pages: DictionaryPage[] = (['characters', 'weapons'] as const).flatMap((folder) =>
    (['ChineseSimplified', 'English'] as const).map((language) => ({ folder, language, rows: [] })));
  let compressed = 0, expanded = 0, selected = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
    compressed += chunk.length; done(compressed > 64 * 1024 * 1024 ? new Error('Archive too large') : null, chunk);
  } });
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  const unzip = createGunzip();
  source.on('error', (error) => limit.destroy(error)); limit.on('error', (error) => unzip.destroy(error));
  source.pipe(limit).pipe(unzip);
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, target: DictionaryPage | undefined;
  let chunks: Buffer[] = [], ended = false, zeroBlocks = 0;
  let subtree: string | undefined; const completed = new Set<string>();
  try {
    for await (const input of unzip) {
      const chunk = input as Buffer; expanded += chunk.length;
      if (expanded > 512 * 1024 * 1024) throw new Error('Expanded archive too large');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const length = Math.min(remaining, buffer.length);
          if (target) chunks.push(buffer.subarray(0, length));
          buffer = buffer.subarray(length); remaining -= length;
          if (!remaining && target) {
            target.rows.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
            target = undefined; chunks = [];
          }
        } else if (padding) {
          const length = Math.min(padding, buffer.length); padding -= length; buffer = buffer.subarray(length);
        } else {
          if (buffer.length < 512) break;
          const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
          if (header.every((byte) => byte === 0)) { zeroBlocks++; if (zeroBlocks >= 2) ended = true; continue; }
          if (ended || zeroBlocks) throw new Error('Invalid tar terminator');
          const text = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
          const size = text(124, 12).trim(), checksum = text(148, 8).trim();
          if (!/^[0-7]+$/.test(size) || !/^[0-7]+$/.test(checksum)) throw new Error('Invalid tar number');
          const sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
          if (sum !== parseInt(checksum, 8)) throw new Error('Invalid tar checksum');
          remaining = parseInt(size, 8); padding = (512 - remaining % 512) % 512;
          if (remaining > 256 * 1024 * 1024) throw new Error('Tar entry too large');
          const prefix = text(345, 155), path = (prefix ? prefix + '/' : '') + text(0, 100);
          // Git archives group each directory contiguously. Stop once the four wanted
          // subtrees end instead of downloading every other language and game asset.
          if (subtree && !path.startsWith(subtree)) { completed.add(subtree); subtree = undefined; }
          if (completed.size === 4 && pages.every((page) => page.rows.length)) return pages;
          if (header[156] === 53 && /^[^/]+\/src\/data\/(ChineseSimplified|English)\/(characters|weapons)\/$/.test(path)) subtree = path;
          const match = /^[^/]+\/src\/data\/(ChineseSimplified|English)\/(characters|weapons)\/[^/]+\.json$/.exec(path);
          if (match && (header[156] === 0 || header[156] === 48)) {
            selected += remaining;
            if (!remaining || remaining > 1024 * 1024 || selected > 12 * 1024 * 1024) throw new Error('Dictionary files too large');
            target = pages.find((page) => page.folder === match[2] && page.language === match[1]);
          }
        }
      }
    }
    if (!ended || remaining || padding || buffer.some((byte) => byte !== 0) || pages.some((page) => !page.rows.length)) throw new Error('Incomplete dictionary archive');
    return pages;
  } finally { source.destroy(); limit.destroy(); unzip.destroy(); }
}
