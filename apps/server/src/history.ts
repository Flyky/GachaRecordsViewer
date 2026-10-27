import { analyzeHistory, genshinMetadata } from '@gacha/gacha-core';
import { rawMetadataHints, type ExportProfile } from '@gacha/uigf';

export function analyzeProfile(profile: ExportProfile) {
  return analyzeHistory(profile.records.map((record) => ({ id: record.id, itemId: record.itemId,
    gachaType: record.gachaType, uigfGachaType: record.pityGroup, time: record.timeLocal, ...rawMetadataHints(record.metadata) })),
  { timezone: profile.timezone, catalog: genshinMetadata, displayLanguage: 'zh-cn' });
}
