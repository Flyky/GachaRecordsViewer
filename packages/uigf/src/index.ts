import { Ajv2020 } from 'ajv/dist/2020.js';
import { compareIds, decimalId, gameTime, genshinMetadata, pityGroup, resolveMetadata, type ItemType, type Rank, type MetadataHints, type MetadataCatalog } from '@gacha/gacha-core';
export type { MetadataCatalog, MetadataSnapshot } from '@gacha/gacha-core';
import v40 from './schemas/v4.0.json' with { type: 'json' };
import v41 from './schemas/v4.1.json' with { type: 'json' };
import v42 from './schemas/v4.2.json' with { type: 'json' };

export const UIGF_VERSIONS = ['v4.0', 'v4.1', 'v4.2'] as const;
export type UigfVersion = typeof UIGF_VERSIONS[number];
export const MAX_PROFILES = 32, MAX_RECORDS = 100000, MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export class UigfError extends Error {
  constructor(readonly code: string, readonly details?: unknown) { super(code); }
}
export interface UigfRecord {
  id: string; item_id: string; time: string; gacha_type: string; uigf_gacha_type: string;
  name?: string; item_type?: string; rank_type?: string; count?: string;
}
export interface UigfProfile { uid: string | number; timezone: number; lang?: string; list: UigfRecord[] }
export interface UigfDocument {
  info: { export_timestamp: number | string; export_app: string; export_app_version: string; version: UigfVersion };
  hk4e?: UigfProfile[];
}
export interface RawMetadata { name?: string; item_type?: string; rank_type?: string; count?: string; lang?: string }
export interface ImportRecord {
  id: string; itemId: string | null; gachaType: string; pityGroup: string; timeLocal: string; timeUtc: string;
  name: string | null; itemType: ItemType | null; rank: Rank | null; metadata: RawMetadata;
}
export interface ImportProfile {
  index: number; uid: string; timezone: number; lang: string | null; records: ImportRecord[];
  metadataIncomplete: number; metadataConflicts: number;
}
export interface DecodedUigf { version: UigfVersion | 'raw-v1'; profiles: ImportProfile[]; skippedBlocks: string[] }

const schemas = { 'v4.0': v40, 'v4.1': v41, 'v4.2': v42 };
const ajv = new Ajv2020({ strict: false, allErrors: false, coerceTypes: false, removeAdditional: false });
const fullValidators = Object.fromEntries(UIGF_VERSIONS.map((version) => [version, ajv.compile(schemas[version])])) as Record<UigfVersion, ReturnType<typeof ajv.compile>>;
const validators = Object.fromEntries(UIGF_VERSIONS.map((version) => [version, ajv.compile({
  $schema: schemas[version].$schema, type: 'object', required: ['info'],
  properties: { info: schemas[version].properties.info, hk4e: schemas[version].properties.hk4e },
})])) as Record<UigfVersion, ReturnType<typeof ajv.compile>>;
export function isUigfVersion(value: unknown): value is UigfVersion { return typeof value === 'string' && UIGF_VERSIONS.includes(value as UigfVersion); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UigfError('UNSUPPORTED_FORMAT');
  return input as Record<string, unknown>;
}
function id(value: string, maxLength: number) {
  if (value.length > maxLength) throw new UigfError('INVALID_IDENTIFIER');
  try { return decimalId(value); } catch { throw new UigfError('INVALID_IDENTIFIER'); }
}
function itemType(value: string | undefined): ItemType | undefined {
  if (value && ['角色', 'character'].includes(value.toLowerCase())) return 'character';
  if (value && ['武器', 'weapon'].includes(value.toLowerCase())) return 'weapon';
  return undefined;
}
export function rawMetadataHints(metadata: RawMetadata): MetadataHints {
  const rank = ['3', '4', '5'].includes(metadata.rank_type ?? '') ? Number(metadata.rank_type) as Rank : undefined;
  const type = itemType(metadata.item_type);
  return { ...(metadata.name ? { name: metadata.name } : {}), ...(metadata.lang ? { lang: metadata.lang } : {}),
    ...(rank ? { rank } : {}), ...(type ? { itemType: type } : {}),
    ...(metadata.rank_type && rank === undefined ? { untrustedFields: ['rank'] } : {}) };
}
export function resolveRawMetadata(itemId: string | null, metadata: RawMetadata, catalog: MetadataCatalog = genshinMetadata) {
  const resolved = resolveMetadata(itemId, rawMetadataHints(metadata), catalog, metadata.lang ?? 'zh-cn');
  return { itemId: resolved.itemId, identityStatus: resolved.identityStatus, name: resolved.name, itemType: resolved.itemType, rank: resolved.rank,
    incomplete: resolved.status !== 'complete', conflict: !!resolved.conflicts.length };
}
export function decodeUigf(input: unknown, catalog: MetadataCatalog = genshinMetadata): DecodedUigf {
  const document = object(input);
  if (!document.info) throw new UigfError('UNSUPPORTED_FORMAT');
  const version = object(document.info).version;
  if (!isUigfVersion(version)) throw new UigfError('UNSUPPORTED_UIGF_VERSION');
  const projected = { info: document.info, ...(document.hk4e === undefined ? {} : { hk4e: document.hk4e }) };
  const validate = validators[version];
  if (!validate(projected)) throw new UigfError('INVALID_UIGF', validate.errors?.map((error) => ({ path: error.instancePath, keyword: error.keyword })));
  const profiles = (projected as UigfDocument).hk4e ?? [];
  return { version, profiles: normalizeProfiles(profiles, catalog), skippedBlocks: ['hkrpg', 'nap', 'hk4e_ugc'].filter((key) => Object.hasOwn(document, key)) };
}

type RawRecord = Omit<UigfRecord, 'item_id'> & { item_id: string | null; lang?: string };
interface RawProfile { uid: string | number; timezone: number; lang?: string | null; list: RawRecord[] }
function normalizeProfiles(profiles: readonly RawProfile[], catalog: MetadataCatalog, raw = false): ImportProfile[] {
  if (profiles.length > MAX_PROFILES || profiles.reduce((count, profile) => count + profile.list.length, 0) > MAX_RECORDS) throw new UigfError('IMPORT_LIMIT_EXCEEDED');
  const uids = new Set<string>();
  const normalized = profiles.map((profile, index): ImportProfile => {
    if (typeof profile.uid === 'number' && (!Number.isSafeInteger(profile.uid) || profile.uid <= 0)) throw new UigfError('INVALID_UID');
    const uid = id(String(profile.uid), 20);
    if (uid === '0' || uids.has(uid)) throw new UigfError('DUPLICATE_OR_INVALID_PROFILE');
    uids.add(uid);
    let metadataIncomplete = 0, metadataConflicts = 0;
    try { gameTime('2026-01-01 00:00:00', profile.timezone); } catch { throw new UigfError('INVALID_TIMEZONE', { profile: index }); }
    const records = profile.list.map((record, recordIndex): ImportRecord => {
      id(record.id, 128); if (record.item_id !== null) id(record.item_id, 64);
      let group: string, timeUtc: string;
      try { group = pityGroup(record.gacha_type, record.uigf_gacha_type); timeUtc = gameTime(record.time, profile.timezone).timeUtc; }
      catch { throw new UigfError('INVALID_RECORD', { profile: index, record: recordIndex }); }
      const metadata: RawMetadata = {};
      for (const key of ['name', 'item_type', 'rank_type', 'count'] as const) {
        const value = record[key];
        if (value !== undefined) {
          if (value.length > (key === 'name' ? 512 : 64)) throw new UigfError('IMPORT_LIMIT_EXCEEDED');
          metadata[key] = value;
        }
      }
      const language = raw ? record.lang : profile.lang;
      if (language) metadata.lang = language;
      const resolved = resolveRawMetadata(record.item_id, metadata, catalog);
      if (resolved.incomplete) metadataIncomplete++;
      if (resolved.conflict) metadataConflicts++;
      return { id: record.id, itemId: record.item_id, gachaType: record.gacha_type, pityGroup: group, timeLocal: record.time,
        timeUtc, name: resolved.name, itemType: resolved.itemType, rank: resolved.rank, metadata };
    });
    return { index, uid, timezone: profile.timezone, lang: profile.lang ?? null, records, metadataIncomplete, metadataConflicts };
  });
  return normalized;
}

const rawRecordProperties = {
  id: { type: 'string', pattern: '^\\d+$', minLength: 1, maxLength: 128 },
  item_id: { anyOf: [{ type: 'string', pattern: '^\\d+$', minLength: 1, maxLength: 64 }, { type: 'null' }] },
  gacha_type: { type: 'string', maxLength: 8 }, uigf_gacha_type: { type: 'string', maxLength: 8 }, time: { type: 'string', maxLength: 32 },
  name: { type: 'string', maxLength: 512 }, item_type: { type: 'string', maxLength: 64 }, rank_type: { type: 'string', maxLength: 64 },
  count: { type: 'string', maxLength: 64 }, lang: { type: 'string', maxLength: 64 },
};
const rawValidator = ajv.compile({ type: 'object', required: ['format', 'version', 'profiles'], additionalProperties: false,
  properties: { format: { const: 'GachaRecordsViewer.raw' }, version: { const: 1 }, exportedAt: { type: 'string', maxLength: 64 },
    profiles: { type: 'array', maxItems: MAX_PROFILES, items: { type: 'object', required: ['uid', 'timezone', 'list'], additionalProperties: false,
      properties: { uid: { anyOf: [{ type: 'string', pattern: '^\\d+$', minLength: 1, maxLength: 20 }, { type: 'integer' }] },
        timezone: { type: 'integer', minimum: -12, maximum: 14 }, lang: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
        list: { type: 'array', maxItems: MAX_RECORDS, items: { type: 'object', required: ['id', 'item_id', 'gacha_type', 'uigf_gacha_type', 'time'], additionalProperties: false, properties: rawRecordProperties } },
      } } },
  } });
export function decodeImportDocument(input: unknown, catalog: MetadataCatalog = genshinMetadata): DecodedUigf {
  const document = object(input);
  if (document.format !== 'GachaRecordsViewer.raw') return decodeUigf(input, catalog);
  if (!rawValidator(document)) throw new UigfError('INVALID_RAW_BACKUP');
  return { version: 'raw-v1', profiles: normalizeProfiles(document.profiles as RawProfile[], catalog, true), skippedBlocks: [] };
}
export function encodeRawBackup(profiles: readonly ExportProfile[], now = Date.now()) {
  // Project source facts only, never derived IDs/names, credentials or private application state.
  return { format: 'GachaRecordsViewer.raw', version: 1, exportedAt: new Date(now).toISOString(), profiles: profiles.map((profile) => ({
    uid: profile.uid, timezone: profile.timezone, lang: profile.lang,
    list: [...profile.records].sort((a, b) => a.timeUtc.localeCompare(b.timeUtc) || compareIds(a.id, b.id)).map((record) => {
      const result: RawRecord = { id: record.id, item_id: record.itemId, gacha_type: record.gachaType, uigf_gacha_type: record.pityGroup, time: record.timeLocal };
      for (const key of ['name', 'item_type', 'rank_type', 'count', 'lang'] as const) if (record.metadata[key] !== undefined) result[key] = record.metadata[key];
      return result;
    }),
  })) };
}

export interface ExportProfile { uid: string; timezone: number; lang: string | null; records: ImportRecord[] }
export function encodeUigf(profiles: readonly ExportProfile[], version: UigfVersion = 'v4.0', now = Date.now(), catalog: MetadataCatalog = genshinMetadata): UigfDocument {
  if (!isUigfVersion(version)) throw new UigfError('UNSUPPORTED_UIGF_VERSION');
  const pending = profiles.reduce((count, profile) => count + profile.records.filter((record) => resolveRawMetadata(record.itemId, record.metadata, catalog).itemId === null).length, 0);
  if (pending) throw new UigfError('ITEM_IDS_PENDING', { count: pending });
  const document: UigfDocument = { info: { export_timestamp: Math.floor(now / 1000), export_app: 'GachaRecordsViewer', export_app_version: '0.1.0', version },
    hk4e: profiles.map((profile) => {
      const languages = new Set(profile.records.filter((record) => record.metadata.name || record.metadata.item_type).map((record) => record.metadata.lang ?? 'unknown'));
      if (profile.lang) languages.add(profile.lang);
      return { uid: profile.uid, timezone: profile.timezone,
        ...(profile.lang && languages.size <= 1 ? { lang: profile.lang } : {}),
        list: [...profile.records].sort((a, b) => a.timeUtc.localeCompare(b.timeUtc) || compareIds(a.id, b.id)).map((record) => {
          // Explicit projection prevents credentials or arbitrary uploaded fields reaching an export.
          const result: UigfRecord = { id: record.id, item_id: resolveRawMetadata(record.itemId, record.metadata, catalog).itemId!, gacha_type: record.gachaType, uigf_gacha_type: record.pityGroup, time: record.timeLocal };
          for (const key of ['name', 'item_type', 'rank_type', 'count'] as const) {
            if (record.metadata[key] !== undefined) result[key] = record.metadata[key];
          }
          return result;
        }) };
    }) };
  const validate = fullValidators[version];
  if (!validate(document)) throw new UigfError('EXPORT_INCOMPATIBLE_VERSION', validate.errors?.map((error) => ({ path: error.instancePath, keyword: error.keyword })));
  return document;
}
export { compareIds, decimalId } from '@gacha/gacha-core';
