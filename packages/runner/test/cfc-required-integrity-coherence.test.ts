import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cfcIntegritySatisfiesFloor,
  cfcIntegritySatisfiesFloorCoherently,
  cfcIntegrityWitnessKey,
} from "../src/cfc/observation.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-integrity-coherence");

// Epic B5, the §8.10.3 soundness edge: `requiredIntegrity` satisfaction is
// pattern-based (a floor names exactly the fields it demands) and — when one
// requirement spans multiple consumed leaves — COHERENT: every leaf must
// satisfy it via one shared witness atom. "Each input was screened by
// someone" is not "the inputs were screened". Red→green documented in the PR:
// with pattern matching alone (coherence hunk reverted), the heterogeneous
// scenario below wrongly commits.

const REVIEWED = "https://example.com/atoms/Reviewed";
const reviewedBy = (by: string) => ({ type: REVIEWED, by });

describe("CFC requiredIntegrity coherence (B5)", () => {
  describe("shared predicate semantics", () => {
    it("floors are atom patterns: named fields constrain, others don't", () => {
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [{ type: REVIEWED }],
      )).toBe(true);
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [{ type: REVIEWED, by: "r2" }],
      )).toBe(false);
      // Exact concrete floors keep their meaning (degenerate pattern).
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [reviewedBy("r1")],
      )).toBe(true);
      expect(cfcIntegritySatisfiesFloor([], [{ type: REVIEWED }])).toBe(false);
    });

    it("coherence: one shared witness across all leaves, per requirement", () => {
      const required = [{ type: REVIEWED }];
      // Homogeneous witness: both leaves carry the SAME atom.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], [reviewedBy("r1"), reviewedBy("r3")]],
        required,
      )).toBe(true);
      // Heterogeneous witnesses: each leaf satisfies the pattern, but via
      // different atoms — incoherent, must fail.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], [reviewedBy("r2")]],
        required,
      )).toBe(false);
      // A leaf with no match at all fails outright.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], []],
        required,
      )).toBe(false);
      // Single leaf reduces to the plain floor.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")]],
        required,
      )).toBe(true);
      // No leaves: vacuously satisfied (the caller's quantification decides
      // whether the gate runs at all).
      expect(cfcIntegritySatisfiesFloorCoherently([], required)).toBe(true);
    });

    it("requirements are per-requirement coherent, jointly conjunctive", () => {
      const approved = { type: "https://example.com/atoms/Approved" };
      // Requirement 1 shares witness r1; requirement 2 shares `approved`.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [
          [reviewedBy("r1"), approved],
          [reviewedBy("r1"), reviewedBy("r2"), approved],
        ],
        [{ type: REVIEWED }, approved],
      )).toBe(true);
      // Requirement 2's witness missing from one leaf: the whole floor fails.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [
          [reviewedBy("r1"), approved],
          [reviewedBy("r1")],
        ],
        [{ type: REVIEWED }, approved],
      )).toBe(false);
    });

    it("keys valueRef-scoped witnesses with scope.projection dropped (§8.10.3)", () => {
      const bound = (projection?: string) => ({
        type: REVIEWED,
        by: "r1",
        scope: {
          valueRef: { "/": "value-doc" },
          ...(projection === undefined ? {} : { projection }),
        },
      });
      // Two projections of the same bound value are the SAME witness.
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/a")))
        .toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/b")));
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, bound()))
        .toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/a")));
      // Different valueRefs stay distinct witnesses.
      const otherValue = {
        type: REVIEWED,
        by: "r1",
        scope: { valueRef: { "/": "other-doc" } },
      };
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, otherValue))
        .not.toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound()));
      // Non-matching atoms have no witness key.
      expect(cfcIntegrityWitnessKey({ type: "other" }, bound())).toBeNull();
      // Coherence across projections of one bound value holds.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[bound("/a")], [bound("/b")]],
        [{ type: REVIEWED }],
      )).toBe(true);
    });
  });

  describe("read-side gate integration", () => {
    const sourceSchema = (id: string) =>
      ({
        type: "string",
        ifc: {
          confidentiality: ["s"],
          integrity: [reviewedBy(id)],
        },
      }) as JSONSchema;

    const runGate = async (
      witnesses: [string, string],
      required: unknown,
    ): Promise<{ ok: boolean; message?: string }> => {
      const storageManager = StorageManager.emulate({ as: signer });
      // The subject here is the read-side coherence matcher. The sink
      // receives a literal carrying no endorsement of its own, and the
      // observing rung of the write-floor dial is what lets "admits a shared
      // witness across every consumed read" reach a committed transaction.
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcWriteFloor: "observe",
      });
      try {
        for (const [index, witness] of witnesses.entries()) {
          const seed = runtime.edit();
          runtime.getCell(
            signer.did(),
            `coherence-src-${index}`,
            sourceSchema(witness),
            seed,
          ).set(`value-${index}`);
          seed.prepareCfc();
          expect((await seed.commit().settled).ok).toBeDefined();
        }

        const tx = runtime.edit();
        for (const [index, witness] of witnesses.entries()) {
          runtime.getCell(
            signer.did(),
            `coherence-src-${index}`,
            sourceSchema(witness),
            tx,
          ).get();
        }
        runtime.getCell(
          signer.did(),
          "coherence-sink",
          {
            type: "object",
            properties: {
              out: {
                type: "string",
                ifc: { requiredIntegrity: [required] },
              },
            },
            required: ["out"],
            // The sink holds what the sources carry, so it declares their
            // confidentiality at the root the transaction writes.
            ifc: { confidentiality: ["s"] },
          } as JSONSchema,
          tx,
        ).set({ out: "derived" });
        // "" = prepare rejected; the commit result carries the reason.
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return {
          ok: result.ok !== undefined,
          message: (result.error as Error | undefined)?.message,
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("rejects heterogeneous per-leaf witnesses for one object-level requirement", async () => {
      // RED without the coherence upgrade: both reads match the pattern via
      // DIFFERENT witnesses and the commit wrongly succeeds.
      const result = await runGate(["r1", "r2"], { type: REVIEWED });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });

    it("admits a shared witness across every consumed read", async () => {
      const result = await runGate(["r1", "r1"], { type: REVIEWED });
      expect(result.ok).toBe(true);
    });

    it("still rejects when a read matches nothing at all", async () => {
      const result = await runGate(["r1", "r2"], reviewedBy("r1"));
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });
  });

  describe("D4 read-prefix narrows the coherent-witness set", () => {
    // Epic D4 (docs/specs/cfc-write-prefix-provenance.md): the coherent floor
    // quantifies over each write's READ PREFIX, not the transaction-global
    // consumed set. A labeled read whose activity-clock position is at/after
    // the last write attempt overlapping the protected path provably did not
    // feed the committed value, so it is excluded from the witness set the
    // floor is judged over. The read-side integration tests above keep BOTH
    // reads in the prefix (they read then write), so they never exercise the
    // prefix's effect on witness coverage; these do, by interleaving a read
    // past the write.

    const sourceSchema = (id: string) =>
      ({
        type: "string",
        ifc: {
          confidentiality: ["s"],
          integrity: [reviewedBy(id)],
        },
      }) as JSONSchema;

    const sinkSchema = {
      type: "object",
      properties: {
        out: {
          type: "string",
          ifc: { requiredIntegrity: [{ type: REVIEWED }] },
        },
      },
      required: ["out"],
      // The sink holds what the sources carry, so it declares their
      // confidentiality at the root the transaction writes.
      ifc: { confidentiality: ["s"] },
    } as JSONSchema;

    // Seed two labeled sources (witnesses A and B), then run one tx that reads
    // A, WRITES the floored sink, and reads B. When `readBAfterWrite`, read B's
    // clock position lands past the sink write's bound, so D4 drops it from
    // /out's read prefix — the floor sees only leaf {A}. Otherwise both reads
    // precede the write and both are in the prefix (the pre-D4 shape).
    const runInterleaved = async (
      witnessA: string,
      witnessB: string,
      readBAfterWrite: boolean,
    ): Promise<{ ok: boolean; message?: string }> => {
      const storageManager = StorageManager.emulate({ as: signer });
      // The subject here is the read-side coherence matcher. The sink
      // receives a literal carrying no endorsement of its own, and the
      // observing rung of the write-floor dial is what lets "admits a
      // heterogeneous witness pair when the second read is past the write
      // bound" reach a committed transaction.
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcWriteFloor: "observe",
      });
      try {
        for (const [index, witness] of [witnessA, witnessB].entries()) {
          const seed = runtime.edit();
          runtime.getCell(
            signer.did(),
            `prefix-src-${index}`,
            sourceSchema(witness),
            seed,
          ).set(`value-${index}`);
          seed.prepareCfc();
          expect((await seed.commit().settled).ok).toBeDefined();
        }

        const tx = runtime.edit();
        const readB = () =>
          runtime.getCell(
            signer.did(),
            "prefix-src-1",
            sourceSchema(witnessB),
            tx,
          ).get();
        runtime.getCell(
          signer.did(),
          "prefix-src-0",
          sourceSchema(witnessA),
          tx,
        )
          .get();
        if (!readBAfterWrite) readB();
        runtime.getCell(signer.did(), "prefix-coherence-sink", sinkSchema, tx)
          .set({ out: "derived" });
        if (readBAfterWrite) readB();
        tx.prepareCfc();
        const result = await tx.commit().settled;
        return {
          ok: result.ok !== undefined,
          message: (result.error as Error | undefined)?.message,
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("admits a heterogeneous witness pair when the second read is past the write bound", async () => {
      // r1 and r2 both match { type: REVIEWED } but via DIFFERENT atoms — the
      // exact shape the coherence upgrade REJECTS when both reads are in the
      // prefix (control below). Here read B (r2) lands after the sink write, so
      // D4 excludes it: the floor is judged over the in-prefix leaf {r1} alone,
      // a single coherent witness, and the write commits. The excluded read is
      // neither demanded (its heterogeneity no longer forces a failure) nor
      // counted as a satisfying witness.
      const result = await runInterleaved("r1", "r2", true);
      expect(result.ok).toBe(true);
    });

    it("control: the same heterogeneous pair rejects when both reads precede the write", async () => {
      // Identical witnesses and sink, but read B stays in the prefix — so the
      // floor sees leaves {r1},{r2} with no shared witness and rejects. This
      // pins the admission above to the prefix narrowing, not to any change in
      // witness matching.
      const result = await runInterleaved("r1", "r2", false);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });
  });
});
