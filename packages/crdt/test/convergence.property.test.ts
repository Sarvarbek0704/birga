import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { RGA } from "../src/index.js";
import type { Op } from "../src/index.js";
import { shuffle } from "./helpers.js";

/**
 * These tests are the point of the whole package. They assert the CRDT's
 * defining property: **any set of operations, applied in any order, on any
 * number of replicas, yields byte-identical text.**
 */

// A single edit command aimed at whichever replica the scenario picks.
type Command =
  | { kind: "insert"; pos: number; char: string }
  | { kind: "delete"; pos: number };

const charArb = fc.constantFrom(..."abcdefg \n".split(""));

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("insert" as const),
    pos: fc.nat(),
    char: charArb,
  }),
  fc.record({
    kind: fc.constant("delete" as const),
    pos: fc.nat(),
  }),
);

const REPLICA_IDS = ["A", "B", "C", "D"];

/**
 * Simulate `numReplicas` replicas that edit **offline** (each sees only its own
 * edits during generation, creating genuine concurrency), and return the full
 * op log together with the live replica objects.
 *
 * `assignments[i]` says which replica executes `commands[i]`.
 */
function simulateOffline(
  numReplicas: number,
  commands: readonly Command[],
  assignments: readonly number[],
): { replicas: RGA[]; log: Op[] } {
  const replicas = REPLICA_IDS.slice(0, numReplicas).map((id) => new RGA(id));
  const log: Op[] = [];

  commands.forEach((cmd, i) => {
    // `assignments` may be shorter than `commands`; fall back to round-robin.
    const who = (assignments[i] ?? i) % numReplicas;
    const r = replicas[who]!;
    if (cmd.kind === "insert") {
      log.push(r.insertAt(cmd.pos % (r.length + 1), cmd.char));
    } else if (r.length > 0) {
      log.push(r.deleteAt(cmd.pos % r.length));
    }
  });

  return { replicas, log };
}

describe("convergence (property-based, fast-check)", () => {
  it("order independence: the same op log in any order yields the same document", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(commandArb, { minLength: 0, maxLength: 120 }),
        fc.array(fc.nat(), { minLength: 0, maxLength: 120 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 3, maxLength: 6 }),
        (numReplicas, commands, assignments, permSeeds) => {
          const { log } = simulateOffline(numReplicas, commands, assignments);

          // Replay the identical log under several independent permutations.
          const texts = permSeeds.map((seed) => {
            const doc = new RGA("Z");
            doc.applyAll(shuffle(log, seed));
            return doc.toString();
          });

          // Every permutation must agree.
          for (const t of texts) expect(t).toBe(texts[0]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("replica convergence: offline edits merge to one document after full sync", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(commandArb, { minLength: 0, maxLength: 120 }),
        fc.array(fc.nat(), { minLength: 0, maxLength: 120 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 4 }),
        (numReplicas, commands, assignments, deliverySeeds) => {
          const { replicas, log } = simulateOffline(numReplicas, commands, assignments);

          // Gossip: every replica receives every op (its own applies are no-ops),
          // each in its own randomised delivery order — the reconnect scenario.
          replicas.forEach((r, i) => {
            const order = shuffle(log, deliverySeeds[i % deliverySeeds.length]! + i);
            r.applyAll(order);
          });

          const expected = replicas[0]!.toString();
          for (const r of replicas) expect(r.toString()).toBe(expected);

          // A brand-new late joiner replaying the log lands in the same place.
          const joiner = new RGA("Z");
          joiner.applyAll(shuffle(log, 7));
          expect(joiner.toString()).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("duplicate delivery is a no-op (idempotence under gossip)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(commandArb, { minLength: 0, maxLength: 80 }),
        fc.array(fc.nat(), { minLength: 0, maxLength: 80 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (numReplicas, commands, assignments, seed) => {
          const { log } = simulateOffline(numReplicas, commands, assignments);

          const once = new RGA("Z");
          once.applyAll(shuffle(log, seed));

          const twice = new RGA("Z");
          const doubled = shuffle([...log, ...log], seed);
          twice.applyAll(doubled);

          expect(twice.toString()).toBe(once.toString());
        },
      ),
      { numRuns: 200 },
    );
  });

  it("snapshots preserve state: restore-then-continue == never-snapshotted", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(commandArb, { minLength: 1, maxLength: 100 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 100 }),
        (numReplicas, commands, assignments) => {
          const { log } = simulateOffline(numReplicas, commands, assignments);

          const direct = new RGA("Z");
          direct.applyAll(log);

          const restored = RGA.fromSnapshot("Z", direct.snapshot());
          expect(restored.toString()).toBe(direct.toString());
        },
      ),
      { numRuns: 200 },
    );
  });
});
