import { describe, expect, it } from 'vitest';
import { decodeUigf, encodeUigf, UIGF_VERSIONS } from '../src/index.js';
import { longId, pull, sample } from './fixtures.js';

describe('UIGF versioned codec', () => {
  it.each(UIGF_VERSIONS)('%s retains mandatory fields and optional metadata through standard-validated export', (version) => {
    const document = sample(version, [pull(), pull('9007199254740993000', { item_id: '99999999', name: '未知物品', rank_type: '4', item_type: '角色', count: '1', gacha_type: '400' })]);
    const decoded = decodeUigf(document);
    expect(decoded.profiles[0]).toMatchObject({ uid: '123456789', timezone: 8, metadataIncomplete: 0 });
    expect(decoded.profiles[0]!.records[0]).toMatchObject({ id: longId, rank: 3, itemType: 'weapon' });
    const exported = encodeUigf(decoded.profiles, version);
    expect(exported.hk4e![0]!.list).toEqual([...document.hk4e![0]!.list].reverse());
    expect(decodeUigf(exported).profiles[0]!.records).toHaveLength(2);
  });
  it('skips unsupported games, accepts absent Genshin and empty profiles; strips arbitrary credentials', () => {
    const document = { ...sample('v4.2', []), stoken: 'secret', info: { ...sample().info, version: 'v4.2', ltoken: 'secret' },
      hkrpg: 'malformed-but-ignored', nap: null, hk4e_ugc: [{ token: 'secret' }] };
    const decoded = decodeUigf(document);
    expect(decoded.skippedBlocks).toEqual(['hkrpg', 'nap', 'hk4e_ugc']);
    expect(encodeUigf(decoded.profiles).hk4e![0]!.list).toEqual([]);
    expect(JSON.stringify(encodeUigf(decoded.profiles))).not.toContain('secret');
    expect(decodeUigf({ info: sample().info }).profiles).toEqual([]);
    const withExtra = sample(); Object.assign(withExtra.hk4e![0]!.list[0]!, { token: 'secret', authkey: 'secret' });
    expect(JSON.stringify(encodeUigf(decodeUigf(withExtra).profiles))).not.toContain('secret');
  });
  it('rejects legacy data, unknown versions, invalid required fields, unsafe numeric IDs and inconsistent groups', () => {
    const wide = decodeUigf(sample('v4.1', [pull('90071992547409930001')]));
    expect(encodeUigf(wide.profiles, 'v4.1').hk4e![0]!.list[0]!.id).toBe('90071992547409930001');
    expect(() => encodeUigf(wide.profiles, 'v4.2')).toThrow('EXPORT_INCOMPATIBLE_VERSION');
    expect(() => decodeUigf(sample('v4.2', [pull('90071992547409930001')]))).toThrow('INVALID_UIGF');
    expect(() => decodeUigf({ uid: '123456789', list: [] })).toThrow('UNSUPPORTED_FORMAT');
    expect(() => decodeUigf({ ...sample(), info: { ...sample().info, version: 'v4.3' } })).toThrow('UNSUPPORTED_UIGF_VERSION');
    expect(() => decodeUigf({ info: { version: 'v4.1' } })).toThrow('INVALID_UIGF');
    const numericRecord = sample(); Object.assign(numericRecord.hk4e![0]!.list[0]!, { id: Number('9007199254740993') });
    expect(() => decodeUigf(numericRecord)).toThrow('INVALID_UIGF');
    const numericUid = sample(); numericUid.hk4e![0]!.uid = Number('9007199254740993');
    expect(() => decodeUigf(numericUid)).toThrow('INVALID_UID');
    expect(() => decodeUigf(sample('v4.0', [pull('1', { uigf_gacha_type: '302' })]))).toThrow('INVALID_RECORD');
    expect(() => decodeUigf(sample('v4.0', [pull('1', { time: '2026-02-30 12:00:00' })]))).toThrow('INVALID_RECORD');
    const duplicates = sample(); duplicates.hk4e!.push(duplicates.hk4e![0]!);
    expect(() => decodeUigf(duplicates)).toThrow('DUPLICATE_OR_INVALID_PROFILE');
  });
  it('keeps unknown and conflicting rarity conservative and does not label mixed languages incorrectly', () => {
    const decoded = decodeUigf(sample('v4.1', [pull('1', { rank_type: '6' }), pull('2', { item_id: '99999999' }), pull('3', { rank_type: '5' })]));
    expect(decoded.profiles[0]).toMatchObject({ metadataIncomplete: 3, metadataConflicts: 2 });
    expect(decoded.profiles[0]!.records.map((record) => record.rank)).toEqual([null, null, null]);
    expect(encodeUigf(decoded.profiles).hk4e![0]!.list[0]!.rank_type).toBe('6');
    const mixed = decodeUigf(sample('v4.1', [pull('1', { name: 'Test' }), pull('2', { name: '测试' })]));
    mixed.profiles[0]!.records[0]!.metadata.lang = 'en-us';
    expect(encodeUigf(mixed.profiles).hk4e![0]!.lang).toBeUndefined();
  });
});
