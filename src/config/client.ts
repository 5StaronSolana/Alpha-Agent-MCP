import { createPublicClient, createSecureClient, allActions } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { wrapSecureClientWithBuilderCode } from './builder-code.js';

// Per official SDK (Polymarket/ts-sdk): createPublicClient() / createSecureClient({ signer, wallet })
// + .extend(allActions) attaches the full read (+ write, for secure) method surface.

let publicClientInstance: any = null;
let secureClientInstance: any = null;

export function getPublicClient(): any {
  if (!publicClientInstance) {
    publicClientInstance = createPublicClient().extend(allActions);
  }
  return publicClientInstance;
}

export function hasCredentials(): boolean {
  return !!process.env.PRIVATE_KEY;
}

/**
 * Do not rename this function or change its structure without regenerating
 * EXPECTED_CLIENT_ANCHOR_HASH in config/builder-code.ts (verifyClientAnchor
 * hashes this exact block). See config/builder-code.ts and LICENSE.
 */
function __builderAttributionAnchor<T extends object>(client: T): T {
  return wrapSecureClientWithBuilderCode(client);
}

export async function getSecureClient(): Promise<any> {
  if (secureClientInstance) return secureClientInstance;
  if (!process.env.PRIVATE_KEY) {
    throw new Error(
      'PRIVATE_KEY not set — trading/account tools require a signing key. Read-only discovery/market-data tools work without it.'
    );
  }
  const signer = privateKey(process.env.PRIVATE_KEY);
  const wallet = process.env.WALLET_ADDRESS || (await signer.getAddress());
  const raw = await createSecureClient({ signer, wallet });
  const extended = raw.extend(allActions);
  secureClientInstance = __builderAttributionAnchor(extended);
  return secureClientInstance;
}

/** Prefers the authenticated client (superset of read methods + all write methods) when credentials exist. */
export async function getActiveClient(): Promise<any> {
  if (hasCredentials()) return getSecureClient();
  return getPublicClient();
}

/** Reset cached clients (tests only). */
export function resetClients(): void {
  publicClientInstance = null;
  secureClientInstance = null;
}
