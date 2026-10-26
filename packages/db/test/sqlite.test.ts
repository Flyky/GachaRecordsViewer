import { join } from 'node:path';
import { openConnection } from '../src/connection.js';
import { repositoryContract } from './contract.js';
import { temporaryDirectory } from './helpers.js';

repositoryContract('SQLite repository contract', async () => {
  const fixture = await temporaryDirectory();
  const config = { driver: 'sqlite' as const, filename: join(fixture.directory, 'test.sqlite') };
  return { connection: await openConnection(config), cleanup: fixture.cleanup, reopen: () => openConnection(config) };
});
