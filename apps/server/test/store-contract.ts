import { describe, it, expect } from "vitest";
import type { DocStore } from "../src/store.js";

/**
 * Behavioural contract every {@link DocStore} must satisfy, run against both the
 * in-memory and Postgres implementations to guarantee parity.
 */
export function runStoreContract(name: string, makeStore: () => Promise<DocStore> | DocStore) {
  describe(`DocStore contract — ${name}`, () => {
    it("assigns strictly increasing seqs and returns ops after a given seq", async () => {
      const s = await makeStore();
      const a = await s.append("d", { v: 1 }, "A");
      const b = await s.append("d", { v: 2 }, "B");
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(await s.head("d")).toBe(2);

      const all = await s.since("d", 0);
      expect(all.map((o) => o.seq)).toEqual([1, 2]);
      expect(all[0]).toMatchObject({ seq: 1, replica: "A", op: { v: 1 } });
      expect((await s.since("d", 1)).map((o) => o.seq)).toEqual([2]);
      expect(await s.since("d", 2)).toHaveLength(0);
      await s.close();
    });

    it("round-trips snapshots and floors head at the snapshot version", async () => {
      const s = await makeStore();
      await s.append("d", { v: 1 }, "A");
      await s.saveSnapshot("d", 5, { hello: "world" });
      expect(await s.loadSnapshot("d")).toEqual({ version: 5, snapshot: { hello: "world" } });
      expect(await s.head("d")).toBeGreaterThanOrEqual(5);
      await s.close();
    });

    it("isolates documents from one another", async () => {
      const s = await makeStore();
      await s.append("a", { x: 1 }, "A");
      expect(await s.head("b")).toBe(0);
      expect(await s.since("b", 0)).toHaveLength(0);
      expect(await s.loadSnapshot("b")).toBeNull();
      await s.close();
    });
  });
}
