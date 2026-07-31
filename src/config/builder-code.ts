import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Permanent builder attribution for every order this server places.
 *
 * `builderCode` is Polymarket's own attribution field on order requests:
 * trading volume routed through a tool carrying a builder code is credited
 * to that builder (see client.listBuilderTrades / listBuilderLeaderboard /
 * fetchBuilderVolume in @polymarket/client).
 *
 * This value is intentionally not an env var or tool argument: it is wired
 * in once, centrally, at the SecureClient factory (see
 * wrapSecureClientWithBuilderCode() and its use in config/client.ts), so no
 * call site can place an order without it, and no agent-supplied argument
 * can override it. See LICENSE for the attribution-preservation terms.
 */
export const BUILDER_CODE =
  '0xf2864b3cfa9b0752432588aeca0c8d8af45d3be852148ff5468dd28c9532a438' as const;

/** Forces BUILDER_CODE onto an order args object, discarding any caller-supplied value. */
export function withBuilderCode<T extends Record<string, unknown>>(
  args: T
): T & { builderCode: string } {
  const { builderCode: _ignored, ...rest } = args as Record<string, unknown>;
  return { ...(rest as T), builderCode: BUILDER_CODE };
}

/**
 * Client methods that accept an order request (builderCode-bearing).
 * wrapSecureClientWithBuilderCode() intercepts exactly these so attribution
 * is enforced regardless of which method name the generic dispatcher routes
 * a call through.
 */
const ORDER_METHODS = new Set([
  'placeLimitOrder',
  'placeMarketOrder',
  'createLimitOrder',
  'createMarketOrder',
  'postOrder',
  'postOrders',
]);

/**
 * Wraps a SecureClient so every order-creating call carries BUILDER_CODE,
 * regardless of what (if anything) the caller passed.
 */
export function wrapSecureClientWithBuilderCode<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      if (typeof prop !== 'string' || !ORDER_METHODS.has(prop)) return bound;
      return (...args: unknown[]) => {
        if (args.length > 0 && args[0] && typeof args[0] === 'object') {
          if (prop === 'postOrders' && Array.isArray((args[0] as any).orders)) {
            const req = args[0] as { orders: Record<string, unknown>[] };
            args[0] = { ...req, orders: req.orders.map((o) => withBuilderCode(o)) };
          } else {
            args[0] = withBuilderCode(args[0] as Record<string, unknown>);
          }
        }
        return bound(...args);
      };
    },
  });
}

// ---- Integrity anchor -----------------------------------------------------
//
// Builder attribution is wired into config/client.ts inside a function
// named __builderAttributionAnchor (search for that exact name — do not
// rename it, that name is how the hash check below finds it). This file and
// that anchor block cross-check each other's compiled output by SHA-256 at
// MCP server startup (see assertBuilderIntegrity() in index.ts):
//
//   - This file's own compiled output is hashed and checked against
//     EXPECTED_BUILDER_FILE_HASH, which lives in index.ts (outside this
//     file, since a file cannot embed a hash of its own final contents).
//   - config/client.ts's anchor block is hashed and checked here against
//     EXPECTED_CLIENT_ANCHOR_HASH.
//
// Editing either side without regenerating the corresponding hash makes the
// server refuse to start with a FATAL error. This catches accidental or
// partial removal; it is not a defense against someone deliberately editing
// both sides together — no purely local integrity check can be. See LICENSE.

const ANCHOR_FUNCTION_NAME = '__builderAttributionAnchor';

export const EXPECTED_CLIENT_ANCHOR_HASH =
  'abef25a8c1a35cb0138cd800283bbb4c8dd2ee6c267ed3b7ea297ae268ea8a44';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function extractAnchorBlock(source: string): string {
  const start = source.indexOf(`function ${ANCHOR_FUNCTION_NAME}`);
  if (start === -1) {
    throw new Error(
      `FATAL: builder attribution anchor (${ANCHOR_FUNCTION_NAME}) not found in config/client.js — the builder attribution wiring has been removed.`
    );
  }
  let depth = 0;
  let bodyStarted = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      bodyStarted = true;
    } else if (ch === '}') {
      depth--;
      if (bodyStarted && depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error('FATAL: builder attribution anchor in config/client.js is malformed (unbalanced braces).');
}

/**
 * Verifies config/client.js still contains an untampered
 * __builderAttributionAnchor block. Throws (callers should treat this as
 * fatal and refuse to start) on any mismatch.
 */
export function verifyClientAnchor(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const clientJsPath = join(here, 'client.js');
  const source = readFileSync(clientJsPath, 'utf8');
  const block = extractAnchorBlock(source);
  const actualHash = sha256(block);
  if (actualHash !== EXPECTED_CLIENT_ANCHOR_HASH) {
    throw new Error('FATAL: builder attribution code has been modified (config/client.js anchor hash mismatch).');
  }
}
