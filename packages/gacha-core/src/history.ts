import { compareIds, decimalId, gameTime, GachaError, pityGroup, validateTimezone, type PityGroup } from './primitives.js';
import { resolveMetadata, type MetadataCatalog, type MetadataHints } from './metadata.js';

export interface GachaRecord extends MetadataHints {
  id: string;
  itemId: string;
  gachaType: string;
  uigfGachaType?: string;
  time: string;
}
export type PityReason = 'unknown-start' | 'known-gap' | 'unknown-rarity';
export interface HistoryBoundary {
  /** Only set when the caller has evidence that this group starts at the first pull. */
  startsAtBeginning?: boolean;
  /** IDs immediately following explicitly known missing history, not inferred date gaps. */
  gapBeforeIds?: readonly string[];
}
export interface HistoryOptions {
  timezone: number;
  catalog: MetadataCatalog;
  displayLanguage?: string;
  boundaries?: Partial<Record<PityGroup, HistoryBoundary>>;
}
interface GroupState { total: number; sinceFive: number; reasons: Set<PityReason>; gaps: Set<string> }

/** Input must be the full saved history of ONE owner/profile; filter and paginate the result. */
export function analyzeHistory(records: readonly GachaRecord[], options: HistoryOptions) {
  validateTimezone(options.timezone);
  const ids = new Set<string>();
  const prepared = records.map((record) => {
    const key = decimalId(record.id);
    if (ids.has(key)) throw new GachaError('DUPLICATE_ID'); ids.add(key);
    const group = pityGroup(record.gachaType, record.uigfGachaType);
    const metadata = resolveMetadata(record.itemId, record, options.catalog, options.displayLanguage);
    return { ...record, group, ...gameTime(record.time, options.timezone), metadata };
  }).sort((a, b) => a.timestamp - b.timestamp || compareIds(a.id, b.id));

  const states = new Map<PityGroup, GroupState>();
  const groupById = new Map(prepared.map((record) => [decimalId(record.id), record.group]));
  for (const [group, boundary] of Object.entries(options.boundaries ?? {})) {
    if (!['100', '200', '301', '302', '500'].includes(group)) throw new GachaError('INVALID_HISTORY_BOUNDARY');
    for (const id of boundary.gapBeforeIds ?? []) {
      if (groupById.get(decimalId(id)) !== group) throw new GachaError('INVALID_HISTORY_BOUNDARY');
    }
  }
  const result = prepared.map((record) => {
    let state = states.get(record.group);
    if (!state) {
      const boundary = options.boundaries?.[record.group];
      state = { total: 0, sinceFive: 0, reasons: new Set(boundary?.startsAtBeginning ? [] : ['unknown-start']),
        gaps: new Set(boundary?.gapBeforeIds?.map(decimalId) ?? []) };
      states.set(record.group, state);
    }
    state.total++; state.sinceFive++;
    if (state.gaps.has(decimalId(record.id))) state.reasons.add('known-gap');
    if (record.metadata.rank === null) state.reasons.add('unknown-rarity');
    const reasons = [...state.reasons];
    const status = state.reasons.has('unknown-rarity') ? 'unknown-rarity' as const
      : reasons.length ? 'partial-history' as const : 'exact' as const;
    const output = { ...record, groupOrdinal: state.total,
      pity: { count: status === 'unknown-rarity' ? null : state.sinceFive,
        observedSinceFiveStar: state.sinceFive, status, reasons } };
    // The five-star's own interval is measured BEFORE resetting the next pull.
    if (record.metadata.rank === 5) { state.sinceFive = 0; state.reasons.clear(); }
    return output;
  });
  return { records: result,
    totals: Object.fromEntries([...states].map(([group, state]) => [group, state.total])) as Partial<Record<PityGroup, number>>,
    metadataIncomplete: result.some((record) => record.metadata.status !== 'complete'),
  };
}
export type AnalyzedRecord = ReturnType<typeof analyzeHistory>['records'][number];
