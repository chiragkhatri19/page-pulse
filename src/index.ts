import { loadConfig } from './config.js';
import { closeFetcher } from './lib/fetcher.js';
import { buildServer } from './server.js';

const config = loadConfig();
const app = buildServer({ config });

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info({ event: 'startup', port: config.PORT }, 'page-pulse listening');
  } catch (err) {
    app.log.fatal({ err }, 'failed to start');
    process.exit(1);
  }
}

/**
 * Graceful shutdown matters for rolling deploys: the platform sends SIGTERM,
 * we stop accepting new connections, let in-flight audits finish, then exit.
 * Without this, every deploy 502s whatever was mid-flight.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: 'shutdown', signal }, 'draining connections');

    const forceExit = setTimeout(() => {
      app.log.error({ event: 'shutdown_timeout' }, 'forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    void app
      .close()
      .then(() => closeFetcher())
      .then(() => {
        clearTimeout(forceExit);
        process.exit(0);
      })
      .catch((err) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  });
}

process.on('unhandledRejection', (reason) => {
  app.log.error({ event: 'unhandled_rejection', reason }, 'unhandled promise rejection');
});

void start();
