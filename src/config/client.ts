import { createPublicClient, createSecureClient, allActions, relayerApiKey } from '@polymarket/client';
import { builderApiKey } from '@polymarket/client/node';
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
 * Optional request authorization (apiKey) for the SDK client.
 *
 * A builder API key (POLY_BUILDER_API_KEY/SECRET/PASSPHRASE) authorizes both
 * builder-attributed CLOB requests and gasless relayer requests, so it takes
 * precedence. A relayer API key (RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS)
 * authorizes gasless relayer requests only.
 */
function getApiKeyAuthorization() {
  const {
    POLY_BUILDER_API_KEY,
    POLY_BUILDER_SECRET,
    POLY_BUILDER_PASSPHRASE,
    RELAYER_API_KEY,
    RELAYER_API_KEY_ADDRESS,
  } = process.env;
  if (POLY_BUILDER_API_KEY && POLY_BUILDER_SECRET && POLY_BUILDER_PASSPHRASE) {
    return builderApiKey({
      key: POLY_BUILDER_API_KEY,
      secret: POLY_BUILDER_SECRET,
      passphrase: POLY_BUILDER_PASSPHRASE,
    });
  }
  if (RELAYER_API_KEY && RELAYER_API_KEY_ADDRESS) {
    return relayerApiKey({ key: RELAYER_API_KEY, address: RELAYER_API_KEY_ADDRESS });
  }
  return undefined;
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
  const apiKey = getApiKeyAuthorization();
  const raw = await createSecureClient(apiKey ? { signer, wallet, apiKey } : { signer, wallet });
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
