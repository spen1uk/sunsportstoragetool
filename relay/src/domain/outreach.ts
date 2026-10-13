import type { PoolClient } from 'pg';
// Implemented with the inventory module (Phase 3). Returns a reason string when a package is stale/invalid, or null when fresh.
export async function verifyPackageFresh(_c: PoolClient, _workspaceId: string, _packageId: string): Promise<string | null> {
  return 'package_verification_unavailable';
}
