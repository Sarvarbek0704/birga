import { describe, it, expect } from "vitest";
import { RGA } from "../src/index.js";
import type { Op } from "../src/index.js";
import { replay, shuffle } from "./helpers.js";

/** Type `text` at the end of `doc`, collecting the ops produced. */
function type(doc: RGA, text: string): Op[] {
  const ops: Op[] = [];
  for (const ch of text) ops.push(doc.insertAt(doc.length, ch));
  return ops;
}

describe("RGA — basic editing", () => {
  it("sequential typing yields the typed text", () => {
    const doc = new RGA("A");
    type(doc, "hello");
    expect(doc.toString()).toBe("hello");
    expect(doc.length).toBe(5);
  });

  it("inserts in the middle", () => {
    const doc = new RGA("A");
    type(doc, "helo");
    doc.insertAt(3, "l"); // he-l-o -> hello
    expect(doc.toString()).toBe("hello");
  });

  it("inserts at the very start", () => {
    const doc = new RGA("A");
    type(doc, "world");
    doc.insertAt(0, "!");
    expect(doc.toString()).toBe("!world");
  });

  it("deletes a character", () => {
    const doc = new RGA("A");
    type(doc, "hello");
    doc.deleteAt(1); // remove first 'l'? index 1 is 'e' -> hllo
    expect(doc.toString()).toBe("hllo");
  });

  it("clamps out-of-range inserts to the ends", () => {
    const doc = new RGA("A");
    type(doc, "ab");
    doc.insertAt(999, "z");
    expect(doc.toString()).toBe("abz");
    doc.insertAt(-5, "y");
    expect(doc.toString()).toBe("yabz");
  });

  it("throws on out-of-range delete", () => {
    const doc = new RGA("A");
    type(doc, "ab");
    expect(() => doc.deleteAt(5)).toThrow(RangeError);
  });
});

describe("RGA — the classic concurrency cases", () => {
  it("two concurrent inserts at the same position converge identically", () => {
    // Both start from the same base, then insert at position 0 concurrently.
    const base = new RGA("A");
    type(base, "XY");
    const ops = base.snapshot(); // shared starting point

    const a = RGA.fromSnapshot("A", ops);
    const b = RGA.fromSnapshot("B", ops);

    const aOp = a.insertAt(0, "a"); // A inserts 'a' before X
    const bOp = b.insertAt(0, "b"); // B inserts 'b' before X, concurrently

    // Exchange the concurrent ops.
    a.apply(bOp);
    b.apply(aOp);

    expect(a.toString()).toBe(b.toString());
    // Deterministic tie-break: higher id sorts first among siblings. Both have
    // counter 3; replica "B" > "A", so 'b' precedes 'a'.
    expect(a.toString()).toBe("baXY");
  });

  it("insert into a deleted region is preserved", () => {
    const a = new RGA("A");
    const ops = type(a, "abc");
    // Replica B sees the same doc, then deletes 'b'...
    const b = new RGA("B");
    b.applyAll(ops);
    const delB = b.deleteAt(1); // delete 'b' -> "ac"
    // ...while A concurrently inserts 'X' after 'b' (into the soon-dead region).
    const insA = a.insertAt(2, "X"); // a b X c

    a.apply(delB);
    b.apply(insA);

    // 'b' is gone on both, but the concurrently-inserted 'X' survives.
    expect(a.toString()).toBe(b.toString());
    expect(a.toString()).toBe("aXc");
  });

  it("concurrent deletes of the same character are idempotent", () => {
    const a = new RGA("A");
    const ops = type(a, "hello");
    const b = new RGA("B");
    b.applyAll(ops);

    const dA = a.deleteAt(0); // both delete 'h'
    const dB = b.deleteAt(0);

    a.apply(dB);
    b.apply(dA);
    // Apply own delete again to prove idempotence.
    a.apply(dA);

    expect(a.toString()).toBe("ello");
    expect(b.toString()).toBe("ello");
  });

  it("applying an op twice changes nothing (idempotence)", () => {
    const doc = new RGA("A");
    const ops = type(doc, "idem");
    const once = replay("X", ops);
    const twice = replay("X", [...ops, ...ops]);
    expect(twice).toBe(once);
  });
});

describe("RGA — offline reconciliation", () => {
  it("two replicas edit offline and converge after sync", () => {
    const seed = new RGA("A");
    const seedOps = type(seed, "The quick fox");
    const snap = seed.snapshot();

    const a = RGA.fromSnapshot("A", snap);
    const b = RGA.fromSnapshot("B", snap);

    // Both go offline and edit independently.
    const aOps: Op[] = [];
    aOps.push(a.insertAt(10, "brown ")); // "The quick brown fox"
    const bOps: Op[] = [];
    // B deletes "quick " and appends.
    for (let i = 0; i < 6; i++) bOps.push(b.deleteAt(4)); // remove "quick "
    for (const ch of " jumps") bOps.push(b.insertAt(b.length, ch));

    // Reconnect: exchange all offline ops.
    a.applyAll(bOps);
    b.applyAll(aOps);

    expect(a.toString()).toBe(b.toString());
    // And a fresh replica replaying everything lands in the same place.
    const all = [...seedOps, ...aOps, ...bOps];
    expect(replay("C", shuffle(all, 42))).toBe(a.toString());
  });
});

describe("RGA — snapshots", () => {
  it("round-trips through a snapshot, tombstones included", () => {
    const doc = new RGA("A");
    type(doc, "hello world");
    doc.deleteAt(5); // drop the space -> "helloworld"
    const restored = RGA.fromSnapshot("B", doc.snapshot());
    expect(restored.toString()).toBe(doc.toString());
    // A late joiner can keep editing on the restored copy.
    restored.insertAt(restored.length, "!");
    expect(restored.toString()).toBe("helloworld!");
  });
});
