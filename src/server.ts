import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { config } from './config.ts';
import { db } from './db.ts';
import { startWorker } from './worker.ts';

const stopWorker = startWorker();
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`SelfSend listening on :${info.port} (transport=${config.transport}, public URL ${config.publicUrl})`);
  if (!config.adminPassword) console.warn('ADMIN_PASSWORD is not set: the dashboard is disabled.');
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  stopWorker();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
