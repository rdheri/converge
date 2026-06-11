import { describe, expect, it } from "vitest";
import { diffTexts } from "../src/client/diff";

function applySplice(oldText: string, splice: { start: number; removed: number; inserted: string }): string {
  return oldText.slice(0, splice.start) + splice.inserted + oldText.slice(splice.start + splice.removed);
}

describe("diffTexts", () => {
  it("returns null for identical texts", () => {
    expect(diffTexts("abc", "abc")).toBeNull();
    expect(diffTexts("", "")).toBeNull();
  });

  it("detects typing, deletion, and replacement", () => {
    expect(diffTexts("helo", "hello")).toEqual({ start: 3, removed: 0, inserted: "l" });
    expect(diffTexts("hello", "helo")).toEqual({ start: 3, removed: 1, inserted: "" });
    expect(diffTexts("hello world", "hello there")).toEqual({ start: 6, removed: 5, inserted: "there" });
    expect(diffTexts("", "pasted text")).toEqual({ start: 0, removed: 0, inserted: "pasted text" });
    expect(diffTexts("wipe me", "")).toEqual({ start: 0, removed: 7, inserted: "" });
  });

  it("any reported splice reproduces the new text (fuzz)", () => {
    const samples = ["", "a", "aa", "aaa", "abab", "hello world", "xxyyxx", "aaa bbb aaa"];
    for (const oldText of samples) {
      for (const newText of samples) {
        const splice = diffTexts(oldText, newText);
        if (splice === null) {
          expect(oldText).toBe(newText);
        } else {
          expect(applySplice(oldText, splice), `${oldText} -> ${newText}`).toBe(newText);
        }
      }
    }
  });
});
