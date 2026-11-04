/**
 * Certifies §3.5's view-relative dependency completeness at the server seam
 * (03-commit-model.md, INV-3): a pending read's `localSeq` array may be
 * NON-CONTIGUOUS in the session's sequence space. A rejected layer the
 * client honored — dropped from its overlay before the read view was built —
 * is legitimately unnamed and imposes no resolution requirement, while a
 * NAMED layer without a commit row still dooms the commit, and an omission
 * is verified against durable history: the staleness scan excludes only
 * the own-session layers the array NAMES (§3.6.3's declared-set
 * exclusion), so omitting a layer whose write is durably integrated
 * conflicts like a foreign write. These tests pin all three sides —
 * sparse acceptance, named-rejected doom, and omitted-durable doom — so a
 * future change cannot quietly forbid the sparse shape or quietly re-trust
 * client discipline.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";

import { type EntityDocument, toDocumentPath } from "../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";

const toEntityDocument = (value: FabricValue): EntityDocument => ({ value });

const withEngine = async (
  body: (engine: Engine) => void | Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await body(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const SESSION = "session:sparse";

/** Seeds the sparse-array scenario: localSeq 1 writes A (accepted, seq 1),
 * localSeq 2 loses a stale confirmed read on A (rejected — the layer the
 * client honors), localSeq 3 blind-writes A (accepted, seq 2 — the surviving
 * layer a later reader still sits on). */
const seedHonoredRejection = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: SESSION,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:A",
        value: toEntityDocument({ revision: "v1" }),
      }],
    },
  });
  expect(() =>
    applyCommit(engine, {
      sessionId: SESSION,
      commit: {
        localSeq: 2,
        reads: {
          // Claims A was never written; A's accepted write at seq 1 makes
          // this stale, so the commit is rejected and its optimistic layer
          // is the one the client drops.
          confirmed: [{ id: "entity:A", path: toDocumentPath([]), seq: 0 }],
          pending: [],
        },
        operations: [{
          op: "set",
          id: "entity:A",
          value: toEntityDocument({ revision: "v2-doomed" }),
        }],
      },
    })
  ).toThrow(ConflictError);
  applyCommit(engine, {
    sessionId: SESSION,
    commit: {
      localSeq: 3,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:A",
        value: toEntityDocument({ revision: "v3" }),
      }],
    },
  });
};

describe("sparse pending dependencies", () => {
  it("accepts a dependency array that omits a rejected layer the client honored", async () => {
    await withEngine((engine) => {
      seedHonoredRejection(engine);

      // The reader's rebuilt view: confirmed A@1 plus the surviving layer 3.
      // The array names [3] only — non-contiguous past the rejected 2 — and
      // basisSeq 1 is the confirmed basis that view reflected. Layer 3's
      // accepted write inside the scan interval is excluded because the
      // array NAMES it (the declared-set exclusion), so the read is not
      // stale.
      const applied = applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 4,
          reads: {
            confirmed: [],
            pending: [{
              id: "entity:A",
              path: toDocumentPath([]),
              localSeq: [3],
              basisSeq: 1,
            }],
          },
          operations: [{
            op: "set",
            id: "entity:B",
            value: toEntityDocument({ derivedFrom: "v3" }),
          }],
        },
      });

      expect(applied.seq).toBe(3);
      expect(read(engine, { id: "entity:B" })).toEqual({
        value: { derivedFrom: "v3" },
      });
    });
  });

  it("still dooms a commit that names the rejected layer", async () => {
    await withEngine((engine) => {
      seedHonoredRejection(engine);

      // The contrast that makes the sparse acceptance meaningful: naming the
      // rejected layer keeps its resolution requirement, and a rejected
      // commit never gets a commit row to resolve to.
      expect(() =>
        applyCommit(engine, {
          sessionId: SESSION,
          commit: {
            localSeq: 4,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:A",
                path: toDocumentPath([]),
                localSeq: [2, 3],
                basisSeq: 1,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:B",
              value: toEntityDocument({ derivedFrom: "v2-doomed" }),
            }],
          },
        })
      ).toThrow("pending dependency not resolved: 2");
    });
  });

  it("rejects an array that omits an accepted layer whose write is durable", async () => {
    await withEngine((engine) => {
      seedHonoredRejection(engine);
      // A second surviving layer on A: localSeq 4, accepted at seq 3. The
      // stack a complete view sits on is now [3, 4].
      applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "entity:A",
            value: toEntityDocument({ revision: "v4" }),
          }],
        },
      });

      // The buggy omission the declared-set exclusion exists to catch: the
      // array names only layer 4, silently dropping layer 3 — whose write
      // is durably integrated at seq 2, inside the scan interval, and NOT
      // declared away by a processed rejection. Under a predecessor-mask
      // exclusion this commit would be wrongly accepted (layer 3 is an own
      // predecessor); the declared set makes it conflict like a foreign
      // write.
      expect(() =>
        applyCommit(engine, {
          sessionId: SESSION,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:A",
                path: toDocumentPath([]),
                localSeq: [4],
                basisSeq: 1,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:B",
              value: toEntityDocument({ derivedFrom: "v4-missing-v3" }),
            }],
          },
        })
      ).toThrow("stale pending read");
    });
  });

  it("accepts the same read when the array names every surviving layer", async () => {
    await withEngine((engine) => {
      seedHonoredRejection(engine);
      applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "entity:A",
            value: toEntityDocument({ revision: "v4" }),
          }],
        },
      });

      // The no-self-conflict guarantee the exclusion preserves: naming both
      // surviving layers ([3, 4], sparse only past the rejected 2) excludes
      // exactly the reader's own attested view, and the commit lands.
      const applied = applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 5,
          reads: {
            confirmed: [],
            pending: [{
              id: "entity:A",
              path: toDocumentPath([]),
              localSeq: [3, 4],
              basisSeq: 1,
            }],
          },
          operations: [{
            op: "set",
            id: "entity:B",
            value: toEntityDocument({ derivedFrom: "v4" }),
          }],
        },
      });

      expect(applied.seq).toBe(4);
      expect(read(engine, { id: "entity:B" })).toEqual({
        value: { derivedFrom: "v4" },
      });
    });
  });

  it("rejects a scalar localSeq that omits an accepted layer", async () => {
    await withEngine((engine) => {
      seedHonoredRejection(engine);
      applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "entity:A",
            value: toEntityDocument({ revision: "v4" }),
          }],
        },
      });

      // The scalar shape is the degenerate single-element array and flows
      // through the same declared-set exclusion: naming 4 alone leaves
      // layer 3's durable write unexcluded in the interval.
      expect(() =>
        applyCommit(engine, {
          sessionId: SESSION,
          commit: {
            localSeq: 5,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:A",
                path: toDocumentPath([]),
                localSeq: 4,
                basisSeq: 1,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:B",
              value: toEntityDocument({ derivedFrom: "scalar" }),
            }],
          },
        })
      ).toThrow("stale pending read");
    });
  });

  describe("patch-writing layers", () => {
    /** Seeds A = { items: {} } at seq 1 (the confirmed basis), then an own
     * PATCH layer at localSeq 1 adding items.first (accepted, seq 2) — the
     * layer whose exclusion or omission the tests below exercise through
     * the patch-scan statement rather than the set/delete one. */
    const seedPatchLayer = (engine: Engine): void => {
      applyCommit(engine, {
        sessionId: "session:seed",
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "entity:P",
            value: toEntityDocument({ items: {} }),
          }],
        },
      });
      applyCommit(engine, {
        sessionId: SESSION,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "entity:P",
            patches: [{ op: "add", path: "/value/items/first", value: 1 }],
          }],
        },
      });
    };

    it("excludes a named layer whose write is a patch", async () => {
      await withEngine((engine) => {
        seedPatchLayer(engine);

        // The patch-scan twin of the no-self-conflict control: layer 1's
        // patch overlaps the read path and sits in (1, head], but the
        // array names it, so the reader lands.
        const applied = applyCommit(engine, {
          sessionId: SESSION,
          commit: {
            localSeq: 2,
            reads: {
              confirmed: [],
              pending: [{
                id: "entity:P",
                path: toDocumentPath(["value", "items"]),
                localSeq: [1],
                basisSeq: 1,
              }],
            },
            operations: [{
              op: "set",
              id: "entity:B",
              value: toEntityDocument({ observedItems: ["first"] }),
            }],
          },
        });

        expect(applied.seq).toBe(3);
      });
    });

    it("rejects an array that omits a patch-writing layer", async () => {
      await withEngine((engine) => {
        seedPatchLayer(engine);
        // A second own layer so the array has something else to name.
        applyCommit(engine, {
          sessionId: SESSION,
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: "entity:P",
              patches: [{ op: "add", path: "/value/items/second", value: 2 }],
            }],
          },
        });

        // Omitting layer 1 leaves its durable patch at seq 2 unexcluded —
        // the patch-scan statement's own omitted-durable doom.
        expect(() =>
          applyCommit(engine, {
            sessionId: SESSION,
            commit: {
              localSeq: 3,
              reads: {
                confirmed: [],
                pending: [{
                  id: "entity:P",
                  path: toDocumentPath(["value", "items"]),
                  localSeq: [2],
                  basisSeq: 1,
                }],
              },
              operations: [{
                op: "set",
                id: "entity:B",
                value: toEntityDocument({ observedItems: ["second"] }),
              }],
            },
          })
        ).toThrow("stale pending read");
      });
    });
  });
});
