import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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

    it("persists the evidence when the builtin then writes the whole record another identity wrote", async () => {
      // The builtin's write at the root replaces the value the other write
      // put there, so what the record holds is the builtin's.

      const paths = await evidenceAfter("mint-gate-overwritten", () => {}, {
        before: (tx, runtime) => {
          runtime.getCell(signer.did(), "mint-gate-overwritten", undefined, tx)
            .setRawUntyped({ note: "chosen", tag: "chosen" }, true);
        },
        whole: true,
      });

      expect(paths).toEqual(expect.arrayContaining([[], ["tag"]]));
    });

    it("makes the prepared digest differ between the same write under the builtin and under another identity", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        const digestOf = (identity: ImplementationIdentity | undefined) => {
          const tx = runtime.edit();
          try {
            setCfcImplementationIdentity(tx, identity);
            runtime.getCell(signer.did(), "mint-gate-digest", undefined, tx)
              .set({ note: "written" });
            setCfcImplementationIdentity(tx, BUILTIN);
            return (tx as ExtendedStorageTransaction).accessForTestingOnly
              .preparedDigest();
          } finally {
            tx.abort();
          }
        };

        expect(digestOf(BUILTIN)).toBe(digestOf(BUILTIN));
        expect(digestOf(undefined)).not.toBe(digestOf(BUILTIN));
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
