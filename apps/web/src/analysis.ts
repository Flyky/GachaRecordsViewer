import type { AnalysisContext, DailyAnalysisResponse, ItemAnalysisResponse, MonthlyAnalysisResponse } from '@gacha/contracts';

export interface AnalysisBundle { items: ItemAnalysisResponse; monthly: MonthlyAnalysisResponse; daily: DailyAnalysisResponse }
export function consistentAnalysis(profileId: string, responses: AnalysisContext[]) {
  const first = responses[0];
  return !!first && responses.every((response) => response.profileId === profileId && response.dataVersion === first.dataVersion && response.historyCount === first.historyCount);
}
export const itemIssueLabel = (reason: string) => ({ 'unknown-type': '类型未知', 'unknown-rank': '星级未知',
  'conflicting-metadata': '元数据矛盾', 'unsupported-combination': '类型与星级组合异常' } as Record<string, string>)[reason] ?? reason;
export const monthlySeries = [
  { key: 'total', label: '总抽数', color: '#326963' }, { key: 'fiveStars', label: '五星数', color: '#b88a32' },
  { key: 'standard', label: '常驻池', color: '#8c78b0' }, { key: 'characterEvent', label: '角色活动池', color: '#5687b2' },
  { key: 'weaponEvent', label: '武器活动池', color: '#bf8274' },
] as const;
