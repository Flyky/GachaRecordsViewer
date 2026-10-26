import { buildApp } from './app.js';
import { initializeDeployment, StartupError } from './deployment.js';

let deployment: Awaited<ReturnType<typeof initializeDeployment>> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  deployment = await initializeDeployment();
  const serveWeb = process.argv.includes('--serve-web');
  app = await buildApp({ logger: true, serveWeb, database: deployment.connection, auth: {
    connection: deployment.connection, adminPassword: deployment.config.adminPassword,
    adminSessionVersion: deployment.adminSessionVersion, credentialKey: deployment.credentialKey,
    publicUrl: deployment.config.publicUrl, development: !serveWeb,
  } });
  const key = deployment.credentialKey;
  app.addHook('onClose', async () => { key.fill(0); });
  app.log.info({ database: deployment.connection.kind, configFile: deployment.config.configFile }, 'Deployment initialized');
  const runningApp = app;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void runningApp.close().catch(() => { console.error('Server shutdown failed.'); process.exitCode = 1; });
    });
  }
  await app.listen({ port: deployment.config.port, host: deployment.config.host });
} catch (error) {
  console.error(error instanceof StartupError ? error.message : 'Server startup failed. Check local deployment configuration and port availability.');
  process.exitCode = 1;
  if (app) await app.close().catch(() => undefined);
  else if (deployment) await deployment.connection.close().catch(() => undefined);
  deployment?.credentialKey.fill(0);
}
