import { expect, it } from 'vitest';
import { MiyousheClient, type Transport } from '../src/index.js';
const role = { uid: '123456789', region: 'cn_gf01', gameBiz: 'hk4e_cn' as const };
const row = { uid: role.uid, id: '9007199254740993009', item_id: '11301', gacha_type: '400', time: '2026-10-27 12:00:00', name: '冷刃', rank_type: '3', item_type: '武器', count: '1' };
it('fetches twenty rows per page, validates long IDs and projects only wish fields', async () => {
  let request: URL | undefined;
  const transport: Transport = async (url) => { request = url; return new Response(JSON.stringify({ retcode: 0, data: { list: [{ ...row, private_field: 'discard' }] } })); };
  const result = await new MiyousheClient({ transport }).getWishPage('fixture-private-key', role, '301');
  expect(request?.searchParams.get('size')).toBe('20'); expect(request?.searchParams.get('end_id')).toBe('0');
  expect(result).toEqual({ nextId: row.id, records: [{ id: row.id, itemId: '11301', time: row.time, gachaType: '400', name: '冷刃', rankType: '3', itemType: '武器', count: '1' }] });
});
it('keeps an absent upstream item ID explicit for exact dictionary resolution in the domain layer', async () => {
  const client = new MiyousheClient({ transport: async () => new Response(JSON.stringify({ retcode: 0, data: { list: [{ ...row, item_id: '' }] } })) });
  expect((await client.getWishPage('fixture-private-key', role, '301')).records[0]?.itemId).toBeNull();
});
it.each([
  [{ ...row, uid: '999' }], [{ ...row, gacha_type: '302' }], [row, row], [{ ...row, id: 9007199254740994 }],
  [{ ...row, item_id: '0' }], [{ ...row, time: 'bad-date' }], [{ ...row, rank_type: '6' }], [{ ...row, count: '2' }], Array(21).fill(row),
])('rejects invalid role, pool, paging, unsafe identifiers and malformed records (%#)', async (list) => {
  const client = new MiyousheClient({ transport: async () => new Response(JSON.stringify({ retcode: 0, data: { list } })) });
  await expect(client.getWishPage('fixture-private-key', role, '301')).rejects.toBeInstanceOf(Error);
});
