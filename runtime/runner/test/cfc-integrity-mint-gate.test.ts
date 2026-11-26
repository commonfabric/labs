import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { describe, it } from "@commonfabric/test-support/test";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  type ExtendedStorageTransaction,
  setCfcImplementationIdentity,
} from "../src/storage/extended-storage-transaction.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("runner-cfc-integrity-mint-gate");

// Regression guard for runtime-evidence integrity minting (audit S4).
//
// InjectionSafe is runtime-minted evidence consumed by requiredIntegrity gates
// and the prompt-injection screen. The pre-fix code persisted whatever integrity
// atoms an author declared in ifc.integrity/addIntegrity, so untrusted pattern
// code could self-attach InjectionSafe to a value it controls and then satisfy
// an InjectionSafe requiredIntegrity gate. Author-declared schemas (verified or
// unattributed identity) must not mint runtime-evidence atoms.
const INJECTION_SAFE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
};

describe("CFC integrity mint gate", () => {
  it("does not let an author-declared InjectionSafe satisfy a requiredIntegrity gate", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      // An author persists a source value with a self-attached InjectionSafe
      // integrity atom (plus a confidentiality atom so the read is labeled).
      const seed = runtime.edit();
      const srcSchema = {
        type: "string",
        ifc: {
          confidentiality: ["s"],
          integrity: [INJECTION_SAFE_ATOM],
        },
      } as const satisfies JSONSchema;
      const src = runtime.getCell(
        signer.did(),
        "mint-gate-src",
        srcSchema,
        seed,
      );
      src.set("attacker-controlled");
      seed.prepareCfc();
      expect((await seed.commit().settled).ok).toBeDefined();

      // A sink requires InjectionSafe integrity on its inputs. The forged atom
      // on the source must not satisfy it.
      const tx = runtime.edit();
      const srcRead = runtime.getCell(
        signer.did(),
        "mint-gate-src",
        srcSchema,
        tx,
      );
      srcRead.get();
      const sink = runtime.getCell(
        signer.did(),
        "mint-gate-sink",
        {
          type: "object",
          properties: {
            out: {
              type: "string",
              ifc: { requiredIntegrity: [INJECTION_SAFE_ATOM] },
            },
          },
          required: ["out"],
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ out: "derived" });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit().settled;
      expect(result.error?.message).toContain("requiredIntegrity failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not let author-declared exchange-rule evidence satisfy a requiredIntegrity gate", async () => {
    // The Epic B1 evidence families: guard atoms exchange rules fire on
    // (screening verdicts, disclosure events, assessor judgments, role
    // membership, boundary context). Forging any of them from a
    // pattern-authored schema would let untrusted code upgrade its own caveat
    // tier or discharge its own material risk, so the mint gate must strip
    // them exactly like InjectionSafe.
    const source = { "/": "evidence-src" };
    const renderRef = { seq: 1, rootRef: { "/": "root" } };
    const forgedAtoms = {
      "boundary-context": {
        type: "https://commonfabric.org/cfc/atom/BoundaryContext",
        key: "sinkClass",
        value: "display",
      },
      "caveat-screened": {
        type: "https://commonfabric.org/cfc/atom/CaveatScreened",
        kind: "prompt-injection-risk-unscreened",
        source,
        stage: "ingress",
        detector: { type: "https://commonfabric.org/cfc/atom/Builtin" },
        verdict: "pass",
      },
      "disclosure-rendered": {
        type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
        kind: "warning",
        source,
        sink: "display",
        renderRef,
        snapshotDigest: "digest",
      },
      "disclosure-acknowledged": {
        type: "https://commonfabric.org/cfc/atom/DisclosureAcknowledged",
        user: "did:key:attacker",
        kind: "warning",
        source,
        renderRef,
        snapshotDigest: "digest",
      },
      "disclaimer-attached": {
        type: "https://commonfabric.org/cfc/atom/DisclaimerAttached",
        sink: "display",
        kind: "warning",
        source,
        disclaimerDigest: "digest",
      },
      "caveat-assessment": {
        type: "https://commonfabric.org/cfc/atom/CaveatAssessment",
        kind: "warning",
        source,
        assessor: { type: "https://commonfabric.org/cfc/atom/Builtin" },
        evidenceDigest: "digest",
        result: "supported",
      },
      "has-role": {
        type: "https://commonfabric.org/cfc/atom/HasRole",
        principal: "did:key:attacker",
        space: "space:victim",
        role: "owner",
      },
    } as const;

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      for (const [name, atom] of Object.entries(forgedAtoms)) {
        const seed = runtime.edit();
        const srcSchema = {
          type: "string",
          ifc: {
            confidentiality: ["s"],
            integrity: [atom],
          },
        } as JSONSchema;
        const src = runtime.getCell(
          signer.did(),
          `evidence-gate-src-${name}`,
          srcSchema,
          seed,
        );
        src.set("attacker-controlled");
        seed.prepareCfc();
        expect((await seed.commit().settled).ok).toBeDefined();

        const tx = runtime.edit();
        runtime.getCell(
          signer.did(),
          `evidence-gate-src-${name}`,
          srcSchema,
          tx,
        ).get();
        runtime.getCell(
          signer.did(),
          `evidence-gate-sink-${name}`,
          {
            type: "object",
            properties: {
              out: {
                type: "string",
                ifc: { requiredIntegrity: [atom] },
              },
            },
            required: ["out"],
          } as JSONSchema,
          tx,
        ).set({ out: "derived" });

        expect(tx.prepareCfc()).toBe("");
        const result = await tx.commit().settled;
        expect(result.error?.message).toContain("requiredIntegrity failed");
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("for a builtin's write that a write by another identity overlaps in its transaction", () => {
    // A builtin's write keeps the runtime-minted evidence its schema names.
    // Another identity's write in the same transaction, at a path the
    // evidence covers, makes the stored value partly that identity's choice,
    // so the evidence must not persist there; elsewhere it still does.

    const BUILTIN = {
      kind: "builtin",
      builtinId: "mint-gate-builtin",
    } as const;
    const VERIFIED: ImplementationIdentity = {
      kind: "verified",
      moduleIdentity: "module:mint-gate-writer",
      symbol: "write",
      bindingPath: ["write"],
    };
    const recordSchema = {
      type: "object",
      properties: {
        note: { type: "string" },
        tag: {
          type: "string",
          ifc: { addIntegrity: [INJECTION_SAFE_ATOM] },
        },
      },
      ifc: { addIntegrity: [INJECTION_SAFE_ATOM] },
    } as const satisfies JSONSchema;

    /**
     * Commits a transaction in which `before` runs under `identity`, then the
     * builtin writes the record `name` through `recordSchema` (in one write
     * at its root when `whole`, otherwise through a diff), and then
     * `after` runs under `identity`, and returns the paths the stored label
     * map holds the evidence at.
     */
    const evidenceAfter = async (
      name: string,
      after: (tx: IExtendedStorageTransaction, runtime: Runtime) => void,
      { before = () => {}, identity, whole = false }: {
        before?: (tx: IExtendedStorageTransaction, runtime: Runtime) => void;
        identity?: ImplementationIdentity;
        whole?: boolean;
      } = {},
    ): Promise<string[][]> => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const tx = runtime.edit();
        setCfcImplementationIdentity(tx, identity);
        before(tx, runtime);
        setCfcImplementationIdentity(tx, BUILTIN);
        const record = runtime.getCell(signer.did(), name, recordSchema, tx);
        if (whole) {
          record.setRawUntyped({ note: "builtin", tag: "builtin" }, true);
        } else {
          record.set({ note: "builtin", tag: "builtin" });
        }
        setCfcImplementationIdentity(tx, identity);
        after(tx, runtime);
        tx.prepareCfc();
        expect((await tx.commit().settled).error).toBeUndefined();
        const rtx = runtime.edit();
        try {
          const id = runtime.getCell(signer.did(), name, undefined, rtx)
            .getAsNormalizedFullLink().id;
          return (readStoredCfcMetadata(rtx, { space: signer.did(), id })
            ?.labelMap.entries ?? [])
            .filter((entry) =>
              (entry.label.integrity ?? []).some((atom) =>
                (atom as { type?: string }).type === INJECTION_SAFE_ATOM.type
              )
            )
            .map((entry) => [...entry.path]);
        } finally {
          rtx.abort();
        }
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("persists the evidence at every path when nothing else writes the record", async () => {
      const paths = await evidenceAfter("mint-gate-alone", () => {});

      expect(paths).toEqual(expect.arrayContaining([[], ["tag"]]));
    });

    it("persists the evidence when another identity writes another document", async () => {
      const paths = await evidenceAfter(
        "mint-gate-other-doc",
        (tx, runtime) => {
          runtime.getCell(signer.did(), "mint-gate-elsewhere", undefined, tx)
            .set({ note: "other" });
        },
      );

      expect(paths).toEqual(expect.arrayContaining([[], ["tag"]]));
    });

    it("drops the evidence at the root and keeps it at a field the other write does not reach", async () => {
      const paths = await evidenceAfter("mint-gate-sibling", (tx, runtime) => {
        runtime.getCell(signer.did(), "mint-gate-sibling", undefined, tx)
          .key("note").set("chosen");
      });

      expect(paths).toEqual([["tag"]]);
    });

    it("drops the evidence at the field the other write reaches", async () => {
      const paths = await evidenceAfter("mint-gate-field", (tx, runtime) => {
        runtime.getCell(signer.did(), "mint-gate-field", undefined, tx)
          .key("tag").set("chosen");
      });

      expect(paths).toEqual([]);
    });

    it("drops the evidence at a field a verified identity's write reaches", async () => {
      const paths = await evidenceAfter("mint-gate-verified", (tx, runtime) => {
        runtime.getCell(signer.did(), "mint-gate-verified", undefined, tx)
          .key("tag").set("chosen");
      }, { identity: VERIFIED });

      expect(paths).toEqual([]);
    });

    it("drops the evidence when another identity wrote the record before the builtin rewrote it whole", async () => {
      // A builtin can read the transaction's view and write it back, so its
      // later write at the root is no evidence that the value is its own.

      const paths = await evidenceAfter("mint-gate-overwritten", () => {}, {
        before: (tx, runtime) => {
          runtime.getCell(signer.did(), "mint-gate-overwritten", undefined, tx)
            .setRawUntyped({ note: "chosen", tag: "chosen" }, true);
        },
        whole: true,
      });

      expect(paths).toEqual([]);
    });

    /**
     * The address of the record `name`'s field `field` (its whole value when
     * `field` is undefined), as the storage transaction beneath `tx` takes
     * it.
     */
    const storageAddress = (
      tx: IExtendedStorageTransaction,
      runtime: Runtime,
      name: string,
      field?: string,
    ) => {
      const link = runtime.getCell(signer.did(), name, undefined, tx)
        .getAsNormalizedFullLink();
      return {
        space: link.space,
        id: link.id,
        type: "application/json" as const,
        path: field === undefined ? ["value"] : ["value", field],
      };
    };

    describe("for a write through the storage transaction beneath the builtin's", () => {
      // A write made there passes none of the extended transaction's write
      // chokepoint, so it carries no identity, whatever the transaction's
      // identity is when it is made.

      it("drops the evidence at the field a single write reaches", async () => {
        const paths = await evidenceAfter("mint-gate-inner", (tx, runtime) => {
          const { error } = tx.tx.write(
            storageAddress(tx, runtime, "mint-gate-inner", "tag"),
            "chosen",
          );
          expect(error).toBeUndefined();
        }, { identity: BUILTIN });

        expect(paths).toEqual([]);
      });

      it("drops the evidence at the field a batch reaches", async () => {
        const paths = await evidenceAfter(
          "mint-gate-inner-batch",
          (tx, runtime) => {
            const { error } = tx.tx.writeBatch!([{
              address: storageAddress(
                tx,
                runtime,
                "mint-gate-inner-batch",
                "tag",
              ),
              value: "chosen",
            }]);
            expect(error).toBeUndefined();
          },
          { identity: BUILTIN },
        );

        expect(paths).toEqual([]);
      });

      it("drops the evidence when it wrote the record before the builtin rewrote it whole", async () => {
        const paths = await evidenceAfter(
          "mint-gate-inner-overwritten",
          () => {},
          {
            before: (tx, runtime) => {
              const { error } = tx.tx.write(
                storageAddress(tx, runtime, "mint-gate-inner-overwritten"),
                { note: "chosen", tag: "chosen" },
              );
              expect(error).toBeUndefined();
            },
            identity: BUILTIN,
            whole: true,
          },
        );

        expect(paths).toEqual([]);
      });

      describe("made after the transaction prepared", () => {
        // Such a write changes what the transaction commits, so the
        // preparation no longer stands, as after any other write.

        /**
         * Commits a transaction in which the builtin writes the record `name`
         * through `recordSchema` and the transaction prepares, and then
         * `after` runs under the builtin's identity, and returns the commit's
         * error and the stored value.
         */
        const commitAfterPreparing = async (
          name: string,
          after: (tx: IExtendedStorageTransaction, runtime: Runtime) => void,
        ) => {
          const storageManager = StorageManager.emulate({ as: signer });
          const runtime = new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager,
          });
          try {
            const tx = runtime.edit();
            setCfcImplementationIdentity(tx, BUILTIN);
            runtime.getCell(signer.did(), name, recordSchema, tx).set({
              note: "builtin",
              tag: "builtin",
            });
            tx.prepareCfc();
            expect(tx.getCfcState().prepare.status).toBe("prepared");
            after(tx, runtime);
            const error = (await tx.commit().settled).error;
            const rtx = runtime.edit();
            try {
              return {
                error,
                stored: runtime.getCell(signer.did(), name, undefined, rtx)
                  .getRaw(),
              };
            } finally {
              rtx.abort();
            }
          } finally {
            await runtime.dispose();
            await storageManager.close();
          }
        };

        it("refuses the commit after a single write", async () => {
          const { error, stored } = await commitAfterPreparing(
            "mint-gate-inner-after-prepare",
            (tx, runtime) => {
              expect(
                tx.tx.write(
                  storageAddress(
                    tx,
                    runtime,
                    "mint-gate-inner-after-prepare",
                    "tag",
                  ),
                  "chosen",
                ).error,
              ).toBeUndefined();
            },
          );

          expect(error?.message).toContain("write-after-prepare");
          expect(stored).toBeUndefined();
        });

        it("refuses the commit after a batch", async () => {
          const { error, stored } = await commitAfterPreparing(
            "mint-gate-inner-batch-after-prepare",
            (tx, runtime) => {
              expect(
                tx.tx.writeBatch!([{
                  address: storageAddress(
                    tx,
                    runtime,
                    "mint-gate-inner-batch-after-prepare",
                    "tag",
                  ),
                  value: "chosen",
                }]).error,
              ).toBeUndefined();
            },
          );

          expect(error?.message).toContain("write-after-prepare");
          expect(stored).toBeUndefined();
        });
      });

      it("aborts the transaction when made during a cooperative yield of its preparation", async () => {
        // Preparation yields a turn between its steps once its slice is
        // spent, and gives up when the transaction's activity moved in that
        // turn. A clock that spends the slice at every reading makes the
        // first step yield, and a callback queued ahead of that turn writes.

        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager,
        });
        const clock = performance as { now: () => number };
        const now = clock.now;
        try {
          const tx = runtime.edit();
          setCfcImplementationIdentity(tx, BUILTIN);
          const name = "mint-gate-inner-during-yield";
          runtime.getCell(signer.did(), name, recordSchema, tx).set({
            note: "builtin",
            tag: "builtin",
          });
          const address = storageAddress(tx, runtime, name, "tag");
          let written = false;
          setTimeout(() => {
            written = tx.tx.write(address, "chosen").error === undefined;
          }, 0);
          let reading = now.call(performance);
          clock.now = () => (reading += 1000);
          try {
            await tx.prepareForCommitCooperatively(
              new AbortController().signal,
            );
          } finally {
            clock.now = now;
          }

          expect(written).toBe(true);
          expect((await tx.commit().settled).error?.name).toBe(
            "StorageTransactionAborted",
          );
          const rtx = runtime.edit();
          try {
            expect(runtime.getCell(signer.did(), name, undefined, rtx).getRaw())
              .toBeUndefined();
          } finally {
            rtx.abort();
          }
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });

      describe("for an operation recorded there with no write", () => {
        // An operation other than a write lands no value of its own: a text
        // change or a mergeable op stands in for the diff of a value written
        // through the ordinary path, a create-only mark is a precondition,
        // and a SQLite write reaches an attached database rather than a
        // document. So the builtin's value and evidence stand.

        const opsSchema = {
          type: "object",
          properties: {
            tag: { type: "string" },
            count: { type: "number" },
            items: { type: "array", items: { type: "string" } },
          },
          ifc: { addIntegrity: [INJECTION_SAFE_ATOM] },
        } as const satisfies JSONSchema;

        /**
         * Commits a transaction in which the builtin writes the record `name`
         * through `opsSchema`, and `after` then runs under the builtin's
         * identity, and returns the commit's error, the stored value, and
         * whether the stored label map holds the evidence at the root.
         */
        const landedAfter = async (
          name: string,
          after: (tx: IExtendedStorageTransaction, runtime: Runtime) => void,
        ) => {
          const storageManager = StorageManager.emulate({ as: signer });
          const runtime = new Runtime({
            apiUrl: new URL("https://example.com"),
            storageManager,
          });
          try {
            const tx = runtime.edit();
            setCfcImplementationIdentity(tx, BUILTIN);
            runtime.getCell(signer.did(), name, opsSchema, tx).set({
              tag: "builtin",
              count: 1,
              items: ["builtin"],
            });
            after(tx, runtime);
            tx.prepareCfc();
            const error = (await tx.commit().settled).error;
            const rtx = runtime.edit();
            try {
              const cell = runtime.getCell(signer.did(), name, undefined, rtx);
              const id = cell.getAsNormalizedFullLink().id;
              const evidenceAtRoot = (readStoredCfcMetadata(rtx, {
                space: signer.did(),
                id,
              })?.labelMap.entries ?? []).some((entry) =>
                entry.path.length === 0 &&
                (entry.label.integrity ?? []).some((atom) =>
                  (atom as { type?: string }).type ===
                    INJECTION_SAFE_ATOM.type
                )
              );
              return { error, stored: cell.getRaw(), evidenceAtRoot };
            } finally {
              rtx.abort();
            }
          } finally {
            await runtime.dispose();
            await storageManager.close();
          }
        };

        it("throws on a text change to a field the builtin wrote, and keeps the builtin's value and evidence", async () => {
          const { error, stored, evidenceAtRoot } = await landedAfter(
            "mint-gate-op-text",
            (tx, runtime) => {
              expect(() =>
                tx.tx.recordTextChanges!(
                  storageAddress(tx, runtime, "mint-gate-op-text", "tag"),
                  [{ from: 0, to: 7, insert: "chosen" }],
                )
              ).toThrow("already wrote the field another way");
            },
          );

          expect(error).toBeUndefined();
          expect(stored).toEqual({
            tag: "builtin",
            count: 1,
            items: ["builtin"],
          });
          expect(evidenceAtRoot).toBe(true);
        });

        for (
          const [what, field, delta] of [
            ["an increment", "count", { op: "increment", by: 41 }],
            ["an append", "items", { op: "append", count: 1 }],
            ["a remove-by-value", "items", {
              op: "remove-by-value",
              value: "builtin",
            }],
          ] as const
        ) {
          it(`keeps the builtin's value and evidence after ${what} recorded with no write`, async () => {
            const name = `mint-gate-op-${delta.op}`;
            const { error, stored, evidenceAtRoot } = await landedAfter(
              name,
              (tx, runtime) => {
                tx.tx.recordMergeableOp!(
                  storageAddress(tx, runtime, name, field),
                  delta,
                );
              },
            );

            expect(error).toBeUndefined();
            expect(stored).toEqual({
              tag: "builtin",
              count: 1,
              items: ["builtin"],
            });
            expect(evidenceAtRoot).toBe(true);
          });
        }

        it("keeps the builtin's value and evidence after a create-only mark", async () => {
          const { error, stored, evidenceAtRoot } = await landedAfter(
            "mint-gate-op-create-only",
            (tx, runtime) => {
              tx.tx.markCreateOnly!(
                storageAddress(tx, runtime, "mint-gate-op-create-only"),
              );
            },
          );

          expect(error).toBeUndefined();
          expect(stored).toEqual({
            tag: "builtin",
            count: 1,
            items: ["builtin"],
          });
          expect(evidenceAtRoot).toBe(true);
        });

        for (
          const [what, sql, refusal] of [
            [
              "a table of the database it names",
              "UPDATE t SET tag = 'chosen'",
              "no such table: t",
            ],
            [
              "the store's documents",
              "UPDATE revision SET data = NULL",
              "SQLite statement rejected",
            ],
          ] as const
        ) {
          it(`refuses the whole commit of a SQLite write to ${what}, which names the record as its database`, async () => {
            const name = `mint-gate-op-sqlite-${sql.split(" ")[1]}`;
            const { error, stored } = await landedAfter(
              name,
              (tx, runtime) => {
                const { id } = storageAddress(tx, runtime, name);
                tx.tx.recordSqliteWrite!(signer.did(), {
                  op: "sqlite",
                  db: { id } as never,
                  sql,
                });
              },
            );

            expect(error?.message).toContain(refusal);
            expect(stored).toBeUndefined();
          });
        }
      });

      it("applies and records nothing of an unmarked batch that also changes a member", async () => {
        // The member write is refused as an unmarked one is, and a run is
        // checked whole before any of it is applied, so the value write in
        // the same run lands nothing, and the evidence stands.

        const paths = await evidenceAfter(
          "mint-gate-inner-mixed-batch",
          (tx, runtime) => {
            const address = storageAddress(
              tx,
              runtime,
              "mint-gate-inner-mixed-batch",
              "tag",
            );
            expect(() =>
              tx.tx.writeBatch!([
                { address, value: "chosen" },
                { address: { ...address, path: ["cfc"] }, value: {} },
              ])
            ).toThrow();
          },
          { identity: BUILTIN },
        );

        expect(paths).toEqual([[], ["tag"]]);
      });
    });

    it("makes the prepared digest differ between the same write under the builtin and under another identity", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const digestOf = (
          identity: ImplementationIdentity | undefined,
          through: "extended" | "storage" = "extended",
        ) => {
          const tx = runtime.edit();
          try {
            setCfcImplementationIdentity(tx, identity);
            // A raw write records no schema input, whose identity the digest
            // would bind on its own.
            const address = {
              space: signer.did(),
              id: "of:mint-gate-digest",
              type: "application/json",
              path: ["value"],
            } as const;
            if (through === "storage") {
              expect(tx.tx.write(address, { note: "written" }).error)
                .toBeUndefined();
            } else {
              tx.writeOrThrow(address, { note: "written" });
            }
            setCfcImplementationIdentity(tx, BUILTIN);
            return (tx as ExtendedStorageTransaction).accessForTestingOnly
              .preparedDigest();
          } finally {
            tx.abort();
          }
        };

        expect(digestOf(BUILTIN)).toBe(digestOf(BUILTIN));
        expect(digestOf(undefined)).not.toBe(digestOf(BUILTIN));
        expect(digestOf(BUILTIN, "storage")).not.toBe(digestOf(BUILTIN));
        expect(digestOf(BUILTIN, "storage")).toBe(digestOf(undefined));
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
