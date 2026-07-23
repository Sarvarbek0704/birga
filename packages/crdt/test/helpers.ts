import { RGA } from "../src/index.js";
import type { Op } from "../src/index.js";

/** Deterministic Fisher–Yates shuffle seeded by a number (repeatable). */
export function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0 || 1;
  const rand = (): number => {
    // LCG (Numerical Recipes constants).
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Apply `ops` to a fresh replica and return the resulting text. */
export function replay(replica: string, ops: readonly Op[]): string {
  const doc = new RGA(replica);
  doc.applyAll(ops);
  return doc.toString();
}
