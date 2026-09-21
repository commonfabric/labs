import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-link-integrity-gate");

const INJECTION_SAFE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
};

describe("CFC link-write integrity gate", () => {
  // Regression guard for runtime-evidence atoms on the link-write path (audit
  // S4 review follow-up). The integrity mint gate originally covered only
  // schema-derived labels; an author could persist a forged InjectionSafe
  // through a link's carried label view (or embedded link schema) and later
  // satisfy an InjectionSafe requiredIntegrity gate. Author-influenced link
  // labels must be gated too; only the runtime-minted LinkReference survives.

  it("filters a forged InjectionSafe carried on a link's label view", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-integrity-target",
        undefined,
        tx,
      );
      const targetId = target.getAsNormalizedFullLink().id;

      // A plain value write makes the target a CFC write target.
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      }, "v");

      // Forge a link-write policy input whose carried label view attaches an
      // InjectionSafe integrity atom (author-controlled).
      tx.recordCfcWritePolicyInput({
        kind: "link-write",
        target: {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "field"],
        },
        source: {
          space: signer.did(),
          scope: "space",
          id: "of:cfc-link-integrity-source",
          path: ["value"],
        },
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: ["leak"],
              integrity: [INJECTION_SAFE_ATOM],
            },
          }],
        },
      });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(target.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                {
                  path: string[];
                  label: {
                    confidentiality?: unknown[];
                    integrity?: Array<{ type?: string }>;
                  };
                }
              >;
            };
          };
        } | undefined;
      };
      const entries =
        replica.getDocument(persistedId)?.cfc?.labelMap?.entries ??
          [];
      const allIntegrity = entries.flatMap((e) => e.label.integrity ?? []);
      // The rest of the carried view persisted, so the integrity check below
      // runs over a label map that was written.
      expect(entries.map((e) => e.label.confidentiality)).toContainEqual([
        "leak",
      ]);
      // The forged InjectionSafe must not have been persisted anywhere.
      expect(
        allIntegrity.some((a) => a?.type?.endsWith("/InjectionSafe")),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a carried CurrentPrincipal reader without a stored source reader", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "unbound-link-reader",
        undefined,
        tx,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      }, "v");
      tx.recordCfcWritePolicyInput({
        kind: "link-write",
        target: {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "field"],
        },
        source: {
          space: signer.did(),
          scope: "space",
          id: "of:cfc-link-reader-source",
          path: ["value"],
        },
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: [{
                type: "https://commonfabric.org/cfc/atom/User",
                subject: { __ctCurrentPrincipal: true },
              }],
            },
          }],
        },
      });
      tx.prepareCfc();
      expect((await tx.commit()).error?.message).toContain(
        "Link CurrentPrincipal confidentiality requires a concrete stored reader",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
