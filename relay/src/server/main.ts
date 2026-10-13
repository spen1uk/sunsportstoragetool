import { buildApp } from './app.js';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';

await migrate();
const app = await buildApp({ logger: true });
await app.listen({ port: config.port, host: '0.0.0.0' });
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
