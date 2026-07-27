/** Live Polymarket agent guide — fetched on demand, never a committed .md file. */

const LLMS_URL = 'https://docs.polymarket.com/llms.txt';
const TTL_MS = 5 * 60 * 1000;

let cached: { text: string; fetchedAt: number } | null = null;

async function fetchGuide(): Promise<string> {
  const res = await fetch(LLMS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${LLMS_URL}: HTTP ${res.status}`);
  }
  return res.text();
}

/** Returns the cached guide if fresh (<5 min old), otherwise refetches. */
export async function getGuide(): Promise<{ text: string; cachedAgeMs: number }> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return { text: cached.text, cachedAgeMs: now - cached.fetchedAt };
  }
  const text = await fetchGuide();
  cached = { text, fetchedAt: now };
  return { text, cachedAgeMs: 0 };
}

/** Forces an immediate refetch, bypassing the TTL cache. */
export async function refreshGuide(): Promise<{ text: string }> {
  const text = await fetchGuide();
  cached = { text, fetchedAt: Date.now() };
  return { text };
}
