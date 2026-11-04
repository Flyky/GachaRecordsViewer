import { expect, it } from 'vitest';
import { decodeImportDocument, encodeRawBackup, encodeUigf, type ExportProfile } from '../src/index.js';

const profile: ExportProfile = { uid: '123456789', timezone: 8, lang: null, records: [{ id: '9007199254740993001', itemId: null,
  gachaType: '301', pityGroup: '301', timeLocal: '2026-11-04 12:00:00', timeUtc: '2026-11-04T04:00:00.000Z', name: '派生显示名', rank: 5, itemType: 'character',
  metadata: { lang: 'zh-cn', name: '新角色原名', rank_type: '5', item_type: '角色', count: '1' },
}] };
it('round-trips raw facts and pending IDs through a separate versioned format without exporting derived values', () => {
  const backup = encodeRawBackup([profile]);
  expect(backup.profiles[0]?.list[0]).toMatchObject({ item_id: null, name: '新角色原名' });
  expect(JSON.stringify(backup)).not.toContain('派生显示名');
  const imported = decodeImportDocument(backup); expect(imported.version).toBe('raw-v1');
  expect(imported.profiles[0]?.records[0]).toMatchObject({ itemId: null, metadata: profile.records[0]?.metadata });
  expect(encodeRawBackup(imported.profiles, Date.parse(backup.exportedAt))).toEqual(backup);
  expect(() => encodeUigf([profile])).toThrowError('ITEM_IDS_PENDING');
});
it('rejects malformed raw backups and leaves the UIGF input contract strict', () => {
  const backup = encodeRawBackup([profile]);
  for (const bad of [{ ...backup, version: 999 }, { ...backup, password: 'not-a-backup-field' }, { ...backup, profiles: [{ ...backup.profiles[0], timezone: 99 }] }]) {
    expect(() => decodeImportDocument(bad)).toThrowError('INVALID_RAW_BACKUP');
  }
});
