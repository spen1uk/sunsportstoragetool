import { migrateToKeychain } from './llm/secrets.ts';
// usage: npm run secret:migrate [-- --remove-file]
// Moves your saved keys into the macOS Keychain, checks each one reads back correctly, then switches Jarvis to use the Keychain.
// The old data/secrets.json is KEPT unless you add --remove-file (do that only after Jarvis has worked once from the Keychain).
try {
  const r = migrateToKeychain(process.argv.includes('--remove-file'));
  console.log(r.moved.length ? `Moved to the Keychain and verified: ${r.moved.join(', ')}.` : 'There were no saved keys to move; the Keychain is now switched on for new keys.');
  console.log(r.removedFile ? 'Removed data/secrets.json.' : 'data/secrets.json was left in place. After Jarvis works from the Keychain, run: npm run secret:migrate -- --remove-file');
  console.log('macOS may ask once whether "node" may use the Keychain item: choose Always Allow. Then restart Jarvis.');
} catch (e) { console.error(`Nothing was changed: ${(e as Error).message}`); process.exit(1); }
