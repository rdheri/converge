export interface TextSplice {
  readonly start: number;
  readonly removed: number;
  readonly inserted: string;
}

/**
 * Derive the single contiguous splice that turns `oldText` into
 * `newText` (longest common prefix/suffix). This is exactly what a
 * textarea edit produces: typing, deleting, pasting over a selection.
 * Returns null when the texts are equal.
 */
export function diffTexts(oldText: string, newText: string): TextSplice | null {
  if (oldText === newText) return null;
  let start = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  return { start, removed: endOld - start, inserted: newText.slice(start, endNew) };
}
