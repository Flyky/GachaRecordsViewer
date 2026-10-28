import snapshot from './catalog/genshin-items.json' with { type: 'json' };
import { createMetadataCatalog } from './metadata.js';

export const genshinMetadata = createMetadataCatalog(snapshot);
export { createMetadataCatalog, resolveMetadata } from './metadata.js';
export type { MetadataCatalog, MetadataHints, MetadataSource, MetadataSnapshot, ResolvedMetadata, ItemMetadata } from './metadata.js';
export { analyzeHistory } from './history.js';
export type { GachaRecord, AnalyzedRecord, HistoryOptions, HistoryBoundary, PityReason } from './history.js';
export { POOLS, pityGroup, compareIds, decimalId, gameTime, validateTimezone, GachaError } from './primitives.js';
export type { GachaType, PityGroup, ItemType, Rank } from './primitives.js';
export { itemStatistics, monthlyStatistics, dailyStatistics } from './statistics.js';
export { luckStatistics } from './luck.js';
export type { CharacterBanner, BannerSnapshot } from './luck.js';
