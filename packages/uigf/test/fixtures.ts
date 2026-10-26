import type { UigfDocument, UigfRecord, UigfVersion } from '../src/index.js';

export const longId = '9007199254740993001';
export function pull(id = longId, overrides: Partial<UigfRecord> = {}): UigfRecord {
  return { id, item_id: '11301', gacha_type: '301', uigf_gacha_type: '301', time: '2026-10-27 12:00:00', ...overrides };
}
export function sample(version: UigfVersion = 'v4.1', list: UigfRecord[] = [pull()]): UigfDocument {
  return { info: { version, export_timestamp: 1793073600, export_app: 'synthetic-test', export_app_version: '1' },
    hk4e: [{ uid: 123456789, timezone: 8, lang: 'zh-cn', list }] };
}
