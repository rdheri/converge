/**
 * Presence colors are derived deterministically from the siteId so every
 * client computes the same color for a given peer with no coordination.
 */
const PALETTE = [
  "#e05252", // red
  "#e0852e", // orange
  "#c9a227", // gold
  "#3fa34d", // green
  "#2aa198", // teal
  "#268bd2", // blue
  "#6c71c4", // violet
  "#d33682", // magenta
  "#859900", // olive
  "#b58900", // amber
] as const;

/** FNV-1a over UTF-16 code units; stable across every JS runtime. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function colorForSite(siteId: string): string {
  const color = PALETTE[fnv1a(siteId) % PALETTE.length];
  return color ?? "#268bd2";
}

/** Random-enough site id for a browser tab; no uuid dependency needed. */
export function generateSiteId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${time}-${rand}`;
}
