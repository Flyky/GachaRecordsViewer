import { randomUUID } from 'node:crypto';
import type { ImportRecord, MetadataCatalog } from '@gacha/uigf';
import { sql } from 'drizzle-orm';
import { ImportError, mergeOnlineRecords } from './imports.js';
import type { ProfileRow } from './repositories.js';
import type { DatabaseConnection } from './types.js';

export function wishLinkRepository(connection: DatabaseConnection, catalog?: MetadataCatalog) {
  return {
    page: (owner: string, uid: string, region: string, timezone: number, records: ImportRecord[], assertActive?: () => void) => connection.transaction(async (tx) => {
      if (connection.kind === 'postgres') await tx.execute(sql`SELECT pg_advisory_xact_lock(72407001, hashtext(${owner}))`);
      assertActive?.();
      const matches = await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE owner_id=${owner} AND game='hk4e' AND uid=${uid}`);
      if (matches.length > 1) throw new ImportError('AMBIGUOUS_PROFILE');
      let profile = matches[0];
      if (profile && profile.timezone !== timezone) throw new ImportError('TIMEZONE_CONFLICT');
      if (profile && !['unknown', region].includes(profile.region)) throw new ImportError('REGION_CONFLICT');
      if (!profile) {
        const id = randomUUID();
        await tx.execute(sql`INSERT INTO game_profiles (id,owner_id,game,uid,region,timezone,lang) VALUES (${id},${owner},'hk4e',${uid},${region},${timezone},'zh-cn')`);
        profile = (await tx.query<ProfileRow>(sql`SELECT * FROM game_profiles WHERE id=${id} AND owner_id=${owner}`))[0]!;
      }
      const counts = await mergeOnlineRecords(tx, owner, profile, records, catalog, 'wish-link', assertActive);
      if (profile.region === 'unknown') await tx.execute(sql`UPDATE game_profiles SET region=${region} WHERE id=${profile.id} AND owner_id=${owner}`);
      assertActive?.();
      return { profileId: profile.id, ...counts };
    }),
  };
}
