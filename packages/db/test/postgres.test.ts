import { describe, it } from 'vitest';
import { openConnection } from '../src/connection.js';
import { repositoryContract } from './contract.js';
import { temporaryPostgres } from './helpers.js';

if (process.env.TEST_DATABASE_URL) {
  repositoryContract('PostgreSQL real-driver repository contract', async () => {
    const fixture = await temporaryPostgres();
    const config = { driver: 'postgres' as const, url: fixture.url };
    return { connection: await openConnection(config), cleanup: fixture.cleanup, reopen: () => openConnection(config) };
  });
} else {
  describe.skip('PostgreSQL requires TEST_DATABASE_URL (not replaced with SQLite)', () => { it('real integration', () => {}); });
}
