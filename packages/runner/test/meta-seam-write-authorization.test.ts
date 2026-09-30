import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";
import {
  isMetaField,
  type MetaField,
  rawMetaWriteAuthorization,
} from "../src/meta-seam.ts";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-meta-seam-write");

// A meta field is a document-root sibling of `value`: `patternIdentity` names
// the program a piece runs, `argument`, `result` and `internal` name the cells
// it is wired to, `schema` names the shape its result is validated against,
// and `slug` names it in the space. Writing one redirects a piece rather than
// editing its data, and the runtime is the only writer with a use for that, so
// `setMetaRaw` marks the writes the runtime makes and the write chokepoint
// refuses every unmarked one.
//
// Pattern-authored code runs in the runtime's own realm and receives runtime
// cells, so it reaches both the cell method and the storage transaction the
// cell is bound to. The casts below stand for that reach: the sandbox erases
// types, so a type that omits a method, or a signature that requires an
// authorization, is a compile-time boundary and not a runtime one.
type RawMetaCellWriter = {
  setMetaRaw(metaField: MetaField, value: FabricValue): void;
};

const forgedIdentity = {
  identity: "of:forged-pattern",
  symbol: "default",
};

describe("meta-seam-write-authorization", () => {
  const withRuntime = async (
    body: (context: {
      runtime: Runtime;
      tx: IExtendedStorageTransaction;
      cell: Cell<{ note: string }>;
      id: URI;
    }) => void,
    cfcEnforcementMode: CfcEnforcementMode = "enforce-explicit",
  ): Promise<void> => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode,
      });
      try {
        const tx = runtime.edit();
        const cell = runtime.getCell<{ note: string }>(
          signer.did(),
          `raw-meta-${crypto.randomUUID()}`,
          undefined,
          tx,
        );
        body({
          runtime,
          tx,
          cell,
          id: cell.getAsNormalizedFullLink().id as URI,
        });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await storageManager.close();
    }
  };

  const documentAddress = (id: URI, path: string[]) => ({
    space: signer.did(),
    id,
    type: "application/json" as const,
    path,
  });

  describe("setMetaRaw()", () => {
    it("writes the meta field it names", async () => {
      await withRuntime(({ cell }) => {
        cell.setMetaRaw(
          "patternIdentity",
          forgedIdentity,
          rawMetaWriteAuthorization,
        );

        expect(cell.getMetaRaw("patternIdentity")).toEqual(forgedIdentity);
      });
    });

    it("authorizes only the write it makes", async () => {
      await withRuntime(({ cell }) => {
        cell.setMetaRaw("slug", "named", rawMetaWriteAuthorization);

        expect(() =>
          (cell as unknown as RawMetaCellWriter).setMetaRaw("slug", "renamed")
        ).toThrow(/meta seam/);
        expect(cell.getMetaRaw("slug")).toBe("named");
      });
    });
  });

  describe("the storage-write chokepoint", () => {
    it("throws on the cell method called without an authorization", async () => {
      await withRuntime(({ cell }) => {
        expect(() =>
          (cell as unknown as RawMetaCellWriter).setMetaRaw(
            "patternIdentity",
            forgedIdentity,
          )
        ).toThrow(/patternIdentity/);
        expect(cell.getMetaRaw("patternIdentity")).toBeUndefined();
      });
    });

    it("throws on a transaction write addressed at a meta field", async () => {
      await withRuntime(({ tx, cell, id }) => {
        expect(() =>
          tx.writeOrThrow(
            documentAddress(id, ["patternIdentity"]),
            forgedIdentity,
          )
        ).toThrow(/patternIdentity/);
        expect(cell.getMetaRaw("patternIdentity")).toBeUndefined();
      });
    });

    it("throws on a transaction write addressed inside a meta field", async () => {
      await withRuntime(({ tx, id }) => {
        expect(() =>
          tx.writeOrThrow(
            documentAddress(id, ["internal", "subject"]),
            "forged",
          )
        ).toThrow(/internal/);
      });
    });

    it("throws on a document-root write whose envelope carries a meta field", async () => {
      await withRuntime(({ tx, cell, id }) => {
        expect(() =>
          tx.writeOrThrow(documentAddress(id, []), {
            value: { note: "kept" },
            patternIdentity: forgedIdentity,
          })
        ).toThrow(/patternIdentity/);
        expect(cell.getMetaRaw("patternIdentity")).toBeUndefined();
      });
    });

    it("throws with CFC enforcement disabled", async () => {
      await withRuntime(({ cell }) => {
        expect(() =>
          (cell as unknown as RawMetaCellWriter).setMetaRaw(
            "patternIdentity",
            forgedIdentity,
          )
        ).toThrow(/patternIdentity/);
      }, "disabled");
    });

    it("accepts a value write at a path named after a meta field", async () => {
      await withRuntime(({ tx, cell, id }) => {
        tx.writeOrThrow(documentAddress(id, ["value", "slug"]), "user-data");

        expect(cell.key("slug" as never).get()).toBe("user-data");
        expect(cell.getMetaRaw("slug")).toBeUndefined();
      });
    });

    it("throws on a document-root write that would drop a document's meta fields", async () => {
      // A document-root write replaces the envelope, so one that names no
      // meta field erases every meta field the document carries.

      await withRuntime(({ tx, cell, id }) => {
        cell.setMetaRaw(
          "patternIdentity",
          forgedIdentity,
          rawMetaWriteAuthorization,
        );

        expect(() =>
          tx.writeOrThrow(documentAddress(id, []), { value: { note: "kept" } })
        ).toThrow(/patternIdentity/);
        expect(cell.getMetaRaw("patternIdentity")).toEqual(forgedIdentity);
      });
    });

    it("throws on a document-root delete of a document carrying meta fields", async () => {
      await withRuntime(({ tx, cell, id }) => {
        cell.setMetaRaw("slug", "named", rawMetaWriteAuthorization);

        expect(() =>
          tx.writeOrThrow(documentAddress(id, []), undefined, { delete: true })
        ).toThrow(/slug/);
        expect(cell.getMetaRaw("slug")).toBe("named");
      });
    });

    it("throws on a meta write to a reserved grant document", async () => {
      // A reserved `grant:cfc:` document is recorded by an arm of the same
      // chokepoint, and a recording arm returns. The seam's refusal comes
      // first, so which document a write names cannot decide whether it is
      // asked for an authorization. CFC is disabled here, the mode in which
      // the recording the grant arm makes is never read back.

      await withRuntime(({ tx }) => {
        expect(() =>
          tx.writeOrThrow(
            documentAddress("grant:cfc:meta-seam-probe" as URI, [
              "patternIdentity",
            ]),
            forgedIdentity,
          )
        ).toThrow(/patternIdentity/);
      }, "disabled");
    });

    it("accepts a document-root write on a document carrying no meta field", async () => {
      await withRuntime(({ tx, cell, id }) => {
        tx.writeOrThrow(documentAddress(id, []), { value: { note: "seeded" } });

        expect(cell.get()).toEqual({ note: "seeded" });
      });
    });

    it("reads the envelope once to decide what a root write drops", async () => {
      // Every meta field a root write could drop sits in the one envelope
      // that write replaces, and the guard reads that envelope.
      //
      // Naming no meta path is the part that matters beyond the read count.
      // Canonicalization strips a leading `value`, so a read of the raw
      // `["slug"]` member and a label on a user field `value.slug` meet at
      // the same logical path, and a recursive read there consumes that
      // user field's label and everything under it. A membership read of the
      // document root consumes the root entry alone.

      await withRuntime(({ tx, id }) => {
        const reads = () =>
          [...getTransactionReadActivities(tx)].filter((read) =>
            read.id === id
          );
        const before = reads().length;
        tx.writeOrThrow(documentAddress(id, []), { value: { note: "one" } });
        const added = reads().slice(before);

        const atRoot = added.filter((read) => read.path.length === 0);
        expect(
          added.filter((read) => isMetaField(read.path[0] ?? "")).map((
            read,
          ) => read.path),
        ).toEqual([]);
        expect(atRoot).toHaveLength(1);
        // The guard observes which meta keys the envelope has, not what any
        // of them holds. Without this mark the same read consumes every entry
        // in the document's label map.
        expect(atRoot[0].nonRecursive).toBe(true);
      });
    });
  });

  describe("a running pattern", () => {
    // A handler receives the cells its pattern was given, and a cell reaches
    // its whole document, meta seam included. The victim here is a separate
    // running piece, so the `patternIdentity` on its document is the one the
    // runtime loads its program from: a handler that could write it would
    // choose the program another piece runs.
    const withVictimAndAttacker = async (
      makeHandlerBody: (
        // deno-lint-ignore no-explicit-any
        commonfabric: any,
      ) => (victim: unknown) => void,
      body: (context: {
        runtime: Runtime;
        victimCell: Cell<{ note: string }>;
        attacker: Cell<{ onAttack: unknown }>;
      }) => Promise<void>,
    ): Promise<void> => {
      const storageManager = StorageManager.emulate({ as: signer });
      try {
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager,
        });
        try {
          const tx = runtime.edit();
          const { commonfabric } = createTrustedBuilder(runtime);
          const { handler, pattern } = commonfabric;
          const handlerBody = makeHandlerBody(commonfabric);
          const Victim = pattern(() => ({ note: "victim" }));
          const attack = handler(
            { type: "object", properties: {} },
            {
              type: "object",
              properties: { victim: { asCell: ["cell"] } },
              required: ["victim"],
            },
            (_event: unknown, { victim }: { victim: unknown }) =>
              handlerBody(victim),
          );
          const Attacker = pattern<{ victim: unknown }>((
            { victim }: { victim: unknown },
          ) => ({
            onAttack: attack({ victim }),
          }));

          const victimCell = runtime.getCell<{ note: string }>(
            signer.did(),
            `raw-meta-victim-${crypto.randomUUID()}`,
            undefined,
            tx,
          );
          runtime.run(tx, Victim, {}, victimCell);
          const attackerCell = runtime.getCell<{ onAttack: unknown }>(
            signer.did(),
            `raw-meta-attacker-${crypto.randomUUID()}`,
            undefined,
            tx,
          );
          const attacker = runtime.run(
            tx,
            Attacker,
            { victim: victimCell },
            attackerCell,
          );
          await tx.commit();
          await attacker.pull();
          await runtime.scheduler.idleWithPendingCommits();

          await body({ runtime, victimCell, attacker });
        } finally {
          await runtime.dispose();
        }
      } finally {
        await storageManager.close();
      }
    };

    it("cannot swap the program a piece it holds a cell for runs", async () => {
      await withVictimAndAttacker(
        () => (victim) => {
          (victim as RawMetaCellWriter).setMetaRaw(
            "patternIdentity",
            forgedIdentity,
          );
        },
        async ({ runtime, victimCell, attacker }) => {
          const running = victimCell.getMetaRaw("patternIdentity");
          const errors: string[] = [];
          runtime.scheduler.onError((error) =>
            errors.push(String(error?.message ?? error))
          );

          attacker.key("onAttack").send({});
          await runtime.scheduler.idleWithPendingCommits();

          expect(victimCell.getMetaRaw("patternIdentity")).toEqual(running);
          expect(victimCell.get()).toEqual({ note: "victim" });
          expect(errors.some((message) => /patternIdentity/.test(message)))
            .toBe(true);
        },
      );
    });

    // The guard covers writes to the seam, not the runtime's own entry points
    // that write it as part of their work, such as instantiating a pattern
    // onto a cell. Those take the runtime, which a cell does not hand pattern
    // code, so a handler holding the victim's cell cannot ask the runtime to
    // run a pattern of its choosing there. It reads the result rather than the
    // identity meta, which a pattern evaluated without a content-addressed
    // entry does not carry.
    it("cannot ask the runtime to run its own pattern on that piece", async () => {
      await withVictimAndAttacker(
        (commonfabric) => {
          const Evil = commonfabric.pattern(() => ({ note: "evil" }));
          return (victim: unknown) => {
            const reachable = victim as unknown as {
              runtime: { run: (...args: unknown[]) => unknown };
              tx: unknown;
            };
            reachable.runtime.run(reachable.tx, Evil, {}, reachable);
          };
        },
        async ({ runtime, victimCell, attacker }) => {
          const errors: string[] = [];
          runtime.scheduler.onError((error) =>
            errors.push(String(error?.message ?? error))
          );

          attacker.key("onAttack").send({});
          await runtime.scheduler.idleWithPendingCommits();

          expect(victimCell.get()).toEqual({ note: "victim" });
          expect(errors).toContainEqual(
            expect.stringContaining("reading 'run'"),
          );
        },
      );
    });
  });
});
