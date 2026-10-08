#!/usr/bin/env node
/**
 * Reptile entry point.
 *
 *   npm start                -> HTTP, starting at port 55667
 *   npm start -- --http      -> the same, explicitly
 *   npm start -- --https     -> a new self-signed certificate in cert/, then HTTPS
 *   npm start -- --port N    -> start at port N instead
 *
 * Nothing about hosting, syncing or discovery survives this process: it all
 * lives in memory. The synchronised files, of course, stay on disk.
 */
import { createApp } from './app.js';
import { createConfig, USAGE } from './config.js';
import { createLogger } from './lib/logger.js';

async function main() {
  const config = createConfig();
  const logger = createLogger('reptile', { level: config.logLevel });

  if (config.help) {
    console.log(USAGE);
    return;
  }
  for (const flag of config.unknownArgs) logger.warn(`ignoring unknown option ${flag}`);

  const app = await createApp({ config, logger });
  const { port } = await app.listen();
  const { identity, discovery } = app;
  const scan = discovery.status();

  logger.info(`Reptile ${identity.version} is running over ${config.protocol.toUpperCase()}`);
  logger.info(`  control panel  ${app.urlFor(port, 'localhost')}${config.allowRemoteUi ? ' (open to the network)' : ' (this computer only)'}`);
  logger.info(`  peers connect  ${identity.address}:${port}`);
  logger.info(`  host           ${identity.hostname}`);
  logger.info(`  session UUID   ${identity.uuid}`);
  logger.info(
    scan.enabled
      ? `  discovery      scanning ports ${scan.ports.ranges} on the local network`
      : '  discovery      off (turn it on from the status bar)',
  );
  if (config.protocol === 'https') logger.info('  the certificate is self-signed and brand new: expect a browser warning');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection:', reason));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception:', error);
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  console.error(`reptile failed to start: ${error.message}`);
  process.exit(1);
});
