#!/usr/bin/env node
/**
 * Pellets entry point.
 *
 *   npm start                -> HTTP  on 0.0.0.0:8080
 *   npm start -- --http      -> same, explicitly
 *   npm start -- --https     -> mints a new self-signed certificate, then HTTPS
 *
 * The whole application - HTTP, static client, WebSocket chat - runs in this
 * single process. Nothing is written to disk except uploaded attachments and
 * the generated certificate.
 */
import { networkInterfaces } from 'node:os';
import { createConfig, USAGE } from './config.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './app.js';

/** Non-internal IPv4 addresses, so the banner can show a LAN URL. */
function lanAddresses() {
  const out = [];
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses || []) {
        if (!address || address.internal) continue;
        if (address.family !== 'IPv4' && address.family !== 4) continue;
        out.push(address.address);
      }
    }
  } catch {
    /* best effort only */
  }
  return out;
}

async function main() {
  const config = createConfig();
  const logger = createLogger('pellets', { level: config.logLevel });

  if (config.help) {
    console.log(USAGE);
    return;
  }
  for (const flag of config.unknownArgs) logger.warn(`ignoring unknown option ${flag}`);

  const app = await createApp({ config, logger });
  const { port } = await app.listen();

  const scheme = config.protocol;
  logger.info(`pellets is listening over ${scheme.toUpperCase()}`);
  logger.info(`  local   ${app.urlFor(port, 'localhost')}`);
  if (config.host === '0.0.0.0' || config.host === '::') {
    for (const address of lanAddresses()) logger.info(`  network ${app.urlFor(port, address)}`);
  }
  if (scheme === 'https') {
    logger.info('  the certificate is self-signed and brand new: expect a browser warning');
  }
  logger.info(`  uploads ${config.uploadsDir}`);
  logger.info('chat state lives in memory only and is lost when this process exits');

  /** Shut down once, cleanly, however the signal arrives. */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Never die silently: log, then let the platform decide.
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection:', reason));
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception:', error);
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  console.error('pellets failed to start:', error);
  process.exit(1);
});
