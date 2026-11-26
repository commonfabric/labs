import { expect } from "@std/expect";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import type { CfcPolicyEvaluationMode } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { setCfcTrustSnapshot } from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-input-requirement-bindings",
);
const other = await Identity.fromPassphrase(
  "runner-cfc-input-requirement-bindings-other",
);
const space = signer.did();

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };
const REVIEWED = "https://example.com/cfc/atom/Reviewed";

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:input-requirement-bindings-module",
  symbol: "rules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

// `PolicyOf<rules>` as the compiler lowers it: the subject is the space that
// owns the document the schema describes.
const POLICY_OF = {
  type: CFC_ATOM_TYPE.Policy,
  policyRefKind: "module",
  moduleIdentity: artifact.manifest.moduleIdentity,
  symbol: artifact.manifest.symbol,
  policyDigest: artifact.policyDigest,
  subject: { __ctOwningSpace: true },
};

describe("cfc-input-requirement-bindings", () => {
  // A schema's input requirements may name the principal the attempt acts
  // for and the space that owns the document. Each is a placeholder the
  // runtime binds before it compares the requirement with what the attempt
  // read (spec §8.10.3), so a requirement naming exactly what was read is met,
  // and one naming something else still is not.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = (mode: CfcPolicyEvaluationMode, servingPosture: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcPolicyEvaluation: mode,
      servingPosture,
    });
    runtime.registerCfcPolicyManifests(space, [artifact]);
    return runtime;
  };

  // Writes "secret" to a source labeled `sourceIfc`, then, in a transaction
  // acting for `actor`, reads it and copies it to `/out` of a target whose
  // `/out` declares `outIfc`. With `actor` null, the transaction's trust
  // snapshot names no principal. With `actor` "served", the copy is a run a
  // serving runtime makes on no one's behalf, under its ambient snapshot.
  // Returns the error the copy's commit fails with.
  const copy = async (
    mode: CfcPolicyEvaluationMode,
    sourceIfc: Record<string, unknown>,
    outIfc: Record<string, unknown>,
    actor: string | null | "served" = signer.did(),
  ) => {
    const runtime = start(mode, actor === "served");
    const sourceSchema = { type: "string", ifc: sourceIfc } as JSONSchema;
    const seed = runtime.edit();
    setCfcTrustSnapshot(seed, { id: `trust-${space}`, actingPrincipal: space });
    runtime.getCell(space, "source", sourceSchema, seed).set("secret");
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    if (actor !== "served") {
      setCfcTrustSnapshot(
        tx,
        actor === null
          ? { id: "trust-nobody" }
          : { id: `trust-${actor}`, actingPrincipal: actor },
      );
    }
    const value = runtime.getCell(space, "source", sourceSchema, tx).get();
    runtime.getCell(space, "target", {
      type: "object",
      properties: { out: { type: "string", ifc: outIfc } },
      required: ["out"],
    } as JSONSchema, tx).set({ out: value } as never);
    return (await tx.commit().settled).error?.message;
  };

  for (const mode of ["off", "enforce"] as const) {
    describe(`with policy evaluation \`${mode}\``, () => {
      describe("a `maxConfidentiality` ceiling naming `CurrentPrincipal`", () => {
        it("admits a value labeled for the acting principal", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(signer.did())],
            }, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }),
          ).toBeUndefined();
        });

        it("admits a value labeled for the acting principal under a bare placeholder", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(signer.did())],
            }, { maxConfidentiality: [CURRENT_PRINCIPAL] }),
          ).toBeUndefined();
        });

        it("admits a value either reader may read under a reader enumeration", async () => {
          expect(
            await copy(mode, {
              confidentiality: [{
                anyOf: [cfcAtom.user(signer.did()), cfcAtom.user(other.did())],
              }],
            }, {
              maxConfidentiality: [{
                anyOf: [CURRENT_PRINCIPAL, cfcAtom.user(other.did())],
              }],
            }),
          ).toBeUndefined();
        });

        it("refuses a value labeled for another principal", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(other.did())],
            }, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }),
          ).toContain("maxConfidentiality failed at /out");
        });

        it("refuses a write no principal acts for", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(signer.did())],
            }, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }, null),
          ).toContain("unbound placeholder in maxConfidentiality at /out");
        });

        it("refuses a write whose snapshot names an empty principal", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(signer.did())],
            }, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }, ""),
          ).toContain("unbound placeholder in maxConfidentiality at /out");
        });

        it("refuses a write a serving runtime makes for no one", async () => {
          // The ambient snapshot such a run carries names the serving
          // runtime itself, which the run does not act for.

          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(signer.did())],
            }, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }, "served"),
          ).toContain("unbound placeholder in maxConfidentiality at /out");
        });

        it("refuses a write no principal acts for of a value nothing labels", async () => {
          // A ceiling must bind even where nothing it applies to was read
          // (spec §8.10.3), so an unlabeled value does not slip past one that
          // cannot.

          expect(
            await copy(mode, {}, {
              maxConfidentiality: [
                { type: CFC_ATOM_TYPE.User, subject: CURRENT_PRINCIPAL },
              ],
            }, null),
          ).toContain("unbound placeholder in maxConfidentiality at /out");
        });
      });

      describe("a `maxConfidentiality` ceiling naming `PolicyOf`", () => {
        it("admits a value labeled with the same policy", async () => {
          expect(
            await copy(mode, { confidentiality: [POLICY_OF] }, {
              maxConfidentiality: [POLICY_OF],
            }),
          ).toBeUndefined();
        });

        it("refuses a value labeled for a principal the policy does not name", async () => {
          expect(
            await copy(mode, {
              confidentiality: [cfcAtom.user(other.did())],
            }, { maxConfidentiality: [POLICY_OF] }),
          ).toContain("maxConfidentiality failed at /out");
        });
      });

      describe("a `requiredIntegrity` floor naming `CurrentPrincipal`", () => {
        it("admits a value reviewed by the acting principal", async () => {
          // The floor is checked on the value written as well as on what was
          // read (spec §8.12.4.1), so the target declares the review too.

          expect(
            await copy(mode, {
              integrity: [{ type: REVIEWED, reviewer: signer.did() }],
            }, {
              integrity: [{ type: REVIEWED, reviewer: signer.did() }],
              requiredIntegrity: [
                { type: REVIEWED, reviewer: CURRENT_PRINCIPAL },
              ],
            }),
          ).toBeUndefined();
        });

        it("refuses a value reviewed by another principal", async () => {
          expect(
            await copy(mode, {
              integrity: [{ type: REVIEWED, reviewer: other.did() }],
            }, {
              requiredIntegrity: [
                { type: REVIEWED, reviewer: CURRENT_PRINCIPAL },
              ],
            }),
          ).toContain("requiredIntegrity failed at /out");
        });
      });
    });
  }
});
