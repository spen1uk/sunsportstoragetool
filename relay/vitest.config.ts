import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], env: { DATABASE_URL: 'postgres://relay:relay_dev_only@localhost:5432/relay_test', RELAY_ENV: 'test' }, fileParallelism: false, testTimeout: 20000 } });
