import { computed, ref, shallowRef, watch } from 'vue';
import type { GameProfileSummary, ProfilesResponse } from '@gacha/contracts';
import { errorMessage, userRequest, userSession } from './auth.js';

export const profiles = shallowRef<GameProfileSummary[]>([]);
export const selectedProfileId = ref<string | null>(null);
export const profilesLoading = ref(false), profilesError = ref('');
export const currentProfile = computed(() => profiles.value.find((profile) => profile.id === selectedProfileId.value) ?? null);
let generation = 0, owner: string | undefined;
function savedSelection() { try { return sessionStorage.getItem(`grv.profile.${owner}`); } catch { return null; } }
export function selectProfile(id: string) {
  if (!owner || !profiles.value.some((profile) => profile.id === id)) return;
  selectedProfileId.value = id;
  try { sessionStorage.setItem(`grv.profile.${owner}`, id); } catch { /* Selection still works in memory. */ }
}
export async function refreshProfiles() {
  if (!owner) return false;
  const requestGeneration = ++generation;
  profilesLoading.value = true; profilesError.value = '';
  try {
    const result = await userRequest<ProfilesResponse>('/api/profiles');
    if (requestGeneration !== generation) return false;
    profiles.value = result.profiles;
    const preferred = selectedProfileId.value ?? savedSelection();
    const next = result.profiles.find((profile) => profile.id === preferred) ?? result.profiles[0];
    if (next) selectProfile(next.id); else selectedProfileId.value = null;
    return true;
  } catch (error) {
    if (requestGeneration === generation) profilesError.value = `无法更新档案列表。${errorMessage(error)}`;
    return false;
  } finally { if (requestGeneration === generation) profilesLoading.value = false; }
}
watch(() => userSession.value?.user.id, (id) => {
  generation++; owner = id; profiles.value = []; selectedProfileId.value = null;
  profilesLoading.value = false; profilesError.value = '';
  if (id) void refreshProfiles();
}, { immediate: true, flush: 'sync' });

export const timezoneLabel = (offset: number) => `UTC${offset >= 0 ? '+' : ''}${offset}`;
export function regionLabel(region: string) {
  return ({ unknown: '离线档案', cn_gf01: '国服官服', cn_qd01: '国服渠道服', os_usa: '美服', os_euro: '欧服', os_asia: '亚服', os_cht: '港澳台服' } as Record<string, string>)[region] ?? region;
}
