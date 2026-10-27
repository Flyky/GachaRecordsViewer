import { decimalId, GachaError, type ItemType, type Rank } from './primitives.js';

export interface MetadataSource { name: string; version: string; url: string; license: string; retrievedAt: string }
export interface ItemMetadata { id: string; itemType: ItemType; rank: Rank; names: Readonly<Record<string, string>> }
export interface MetadataSnapshot { schemaVersion: 1; game: 'hk4e'; source: MetadataSource; items: ItemMetadata[] }
export interface MetadataCatalog {
  source: Readonly<MetadataSource>;
  size: number;
  all(): readonly Readonly<ItemMetadata>[];
  get(itemId: string): Readonly<ItemMetadata> | undefined;
  find(name: string, language: string, itemType: ItemType, rank: Rank): Readonly<ItemMetadata> | undefined;
}
export interface MetadataHints {
  name?: string | null; lang?: string | null; itemType?: ItemType | null; rank?: Rank | null;
  /** An explicitly invalid source value must not silently fall back to the dictionary. */
  untrustedFields?: readonly ('rank' | 'itemType')[];
}
export type MetadataField = 'name' | 'itemType' | 'rank';
export interface ResolvedMetadata {
  name: string | null;
  nameLanguage: string | null;
  itemType: ItemType | null;
  rank: Rank | null;
  status: 'complete' | 'incomplete' | 'conflict';
  missing: MetadataField[];
  conflicts: MetadataField[];
  provenance: Record<MetadataField, 'record' | 'dictionary' | 'unknown' | 'conflict'>;
  dictionaryVersion: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GachaError('INVALID_METADATA');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new GachaError('INVALID_METADATA');
  return value;
}
const validRank = (value: unknown): value is Rank => value === 3 || value === 4 || value === 5;
const validType = (value: unknown): value is ItemType => value === 'character' || value === 'weapon';

/** Validate a replacement completely before exposing it; existing catalogs remain immutable. */
export function createMetadataCatalog(input: unknown): MetadataCatalog {
  const raw = object(input), source = object(raw.source);
  if (raw.schemaVersion !== 1 || raw.game !== 'hk4e' || !Array.isArray(raw.items)) throw new GachaError('INVALID_METADATA');
  const origin: MetadataSource = { name: text(source.name), version: text(source.version), url: text(source.url),
    license: text(source.license), retrievedAt: text(source.retrievedAt) };
  const items = new Map<string, Readonly<ItemMetadata>>();
  for (const value of raw.items) {
    const row = object(value), id = decimalId(text(row.id));
    if (!validRank(row.rank) || !validType(row.itemType) || items.has(id)) throw new GachaError('INVALID_METADATA');
    const names: Record<string, string> = Object.create(null);
    for (const [language, name] of Object.entries(object(row.names))) {
      const lang = text(language).toLowerCase();
      if (Object.hasOwn(names, lang)) throw new GachaError('INVALID_METADATA');
      names[lang] = text(name);
    }
    if (!Object.keys(names).length) throw new GachaError('INVALID_METADATA');
    items.set(id, Object.freeze({ id, itemType: row.itemType, rank: row.rank, names: Object.freeze(names) }));
  }
  return Object.freeze({ source: Object.freeze(origin), size: items.size, all: () => [...items.values()], get: (itemId: string) => items.get(decimalId(itemId)),
    find: (name: string, language: string, itemType: ItemType, rank: Rank) => {
      const matches = [...items.values()].filter((item) => item.names[language.toLowerCase()] === name && item.itemType === itemType && item.rank === rank);
      return matches.length === 1 ? matches[0] : undefined;
    },
  });
}

/** Names can differ by language; conflicting rank/type are not silently trusted. */
export function resolveMetadata(itemId: string, hints: MetadataHints, catalog: MetadataCatalog, language = 'zh-cn'): ResolvedMetadata {
  if (hints.rank != null && !validRank(hints.rank) || hints.itemType != null && !validType(hints.itemType)) throw new GachaError('INVALID_METADATA');
  const item = catalog.get(itemId), requestedLanguage = language.toLowerCase();
  const recordLanguage = hints.lang?.toLowerCase() || null;
  const recordName = hints.name?.trim() || null;
  const sameLanguage = !recordLanguage || recordLanguage === requestedLanguage;
  let name = sameLanguage ? recordName : null, nameLanguage = name ? recordLanguage : null;
  let nameSource: ResolvedMetadata['provenance']['name'] = name ? 'record' : 'unknown';
  if (!name && item?.names[requestedLanguage]) { name = item.names[requestedLanguage]!; nameLanguage = requestedLanguage; nameSource = 'dictionary'; }
  if (!name && recordName) { name = recordName; nameLanguage = recordLanguage; nameSource = 'record'; }
  if (!name && item) {
    const fallback = item.names['zh-cn'] ? 'zh-cn' : item.names['en-us'] ? 'en-us' : Object.keys(item.names).sort()[0]!;
    name = item.names[fallback]!; nameLanguage = fallback; nameSource = 'dictionary';
  }
  const conflicts: MetadataField[] = [];
  const rankConflict = hints.untrustedFields?.includes('rank') || hints.rank != null && item && hints.rank !== item.rank;
  const typeConflict = hints.untrustedFields?.includes('itemType') || hints.itemType != null && item && hints.itemType !== item.itemType;
  if (rankConflict) conflicts.push('rank');
  if (typeConflict) conflicts.push('itemType');
  const rank = rankConflict ? null : hints.rank ?? item?.rank ?? null;
  const itemType = typeConflict ? null : hints.itemType ?? item?.itemType ?? null;
  const missing: MetadataField[] = [];
  if (!name) missing.push('name'); if (!rank) missing.push('rank'); if (!itemType) missing.push('itemType');
  return { name, nameLanguage, rank, itemType, missing, conflicts,
    status: conflicts.length ? 'conflict' : missing.length ? 'incomplete' : 'complete',
    provenance: { name: nameSource,
      rank: rankConflict ? 'conflict' : hints.rank != null ? 'record' : item ? 'dictionary' : 'unknown',
      itemType: typeConflict ? 'conflict' : hints.itemType != null ? 'record' : item ? 'dictionary' : 'unknown' },
    dictionaryVersion: `${catalog.source.name}@${catalog.source.version}`,
  };
}
