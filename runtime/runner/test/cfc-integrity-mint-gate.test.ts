import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

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
});
