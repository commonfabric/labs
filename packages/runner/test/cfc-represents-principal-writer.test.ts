import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import {
  PRINCIPAL_CLAIM_KINDS,
  principalClaimSubject,
  representsPrincipalSubject,
} from "../src/cfc/represents-principal.ts";
import { writeResultSchemaMeta } from "../src/result-schema-meta.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

const alice = await Identity.fromPassphrase(
  "runner-represents-principal-writer-alice",
);
const bob = await Identity.fromPassphrase(
  "runner-represents-principal-writer-bob",
);

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

const createRuntime = () => {
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  return { runtime, storageManager };
};

const uiContract = {
  helper: "UiAction",
  action: "EditProfile",
  trustedPattern: "ProfileHome",
  requiredEventIntegrity: ["ProfileHome"],
};

// A field whose schema attaches `atoms` as integrity, with the rest of what a
// current-principal claim needs to commit, so the only thing that can refuse
// the write is the check on the claim itself.
const claimSchema = (
  atoms: unknown[],
  extra: Record<string, unknown> = {},
): JSONSchema => ({
  type: "object",
  properties: {
    name: {
      type: "string",
      ifc: {
        addIntegrity: atoms,
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "/attacker.tsx",
            path: ["writeName"],
          },
        },
        uiContract,
        ...extra,
      },
    },
  },
  required: ["name"],
} as JSONSchema);

const actAsPatternFor = (
  tx: IExtendedStorageTransaction,
  actingPrincipal: string,
) => {
  tx.setCfcEnforcementMode("enforce-strict");
  tx.setCfcTrustSnapshot({
    id: `trust-${actingPrincipal}`,
    actingPrincipal,
  });
  tx.setCfcImplementationIdentity({
    kind: "verified",
    moduleIdentity: "attacker-module",
    sourceFile: "/attacker.tsx",
    bindingPath: ["writeName"],
  });
};

const recordTrustedEdit = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
) => {
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path: ["name"],
    },
    eventId: "trusted-name-edit",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileHome",
        eventIntegrity: ["ProfileHome"],
        uiContractDataset: { uiAction: "EditProfile" },
      },
    },
  });
};

type StoredLabelEntry = {
  path: string[];
  label: { integrity?: unknown[] };
};

// Alice's pattern writes `name` under `schema`. Returns the commit error, if
// any, and every principal a reader resolves from the stored label's atoms.
const writeAsAlice = async (schema: JSONSchema, cause: string) => {
  const { runtime, storageManager } = createRuntime();
  try {
    const tx = runtime.edit();
    actAsPatternFor(tx, alice.did());
    const cell = runtime.getCell(alice.did(), cause, schema, tx);
    cell.set({ name: "Bob" });
    const target = cell.getAsNormalizedFullLink();
    recordTrustedEdit(tx, target);
    tx.prepareCfc();
    const result = await tx.commit();
    const verify = runtime.edit();
    const stored = verify.readOrThrow({
      space: target.space,
      scope: target.scope,
      id: target.id,
      path: [],
    }) as { cfc?: { labelMap?: { entries?: StoredLabelEntry[] } } } | undefined;
    verify.abort();
    const principals = (stored?.cfc?.labelMap?.entries ?? []).flatMap((entry) =>
      (entry.label.integrity ?? []).flatMap((atom) => {
        const subject = representsPrincipalSubject(atom);
        return subject === undefined ? [] : [subject];
      })
    );
    return { error: result.error?.message, principals };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

// Every subject a principal claim of either kind names in the label stored on
// `target`'s document.
const storedClaimSubjects = (
  runtime: Runtime,
  target: NormalizedFullLink,
): string[] => {
  const verify = runtime.edit();
  const stored = verify.readOrThrow({
    space: target.space,
    scope: target.scope,
    id: target.id,
    path: [],
  }) as { cfc?: { labelMap?: { entries?: StoredLabelEntry[] } } } | undefined;
  verify.abort();
  return (stored?.cfc?.labelMap?.entries ?? []).flatMap((entry) =>
    (entry.label.integrity ?? []).flatMap((atom) =>
      [...PRINCIPAL_CLAIM_KINDS].flatMap((kind) => {
        const subject = principalClaimSubject(atom, kind);
        return subject === undefined ? [] : [subject];
      })
    )
  );
};

describe("represents-principal writer check", () => {
  describe("on a schema write", () => {
    const forgeries: [string, () => unknown[]][] = [
      ["the object form naming another DID", () => [{
        kind: "represents-principal",
        subject: bob.did(),
      }]],
      ["the string form", () => [`represents-principal:${bob.did()}`]],
      ["the string form with a padded subject", () => [
        `represents-principal: ${bob.did()} `,
      ]],
      ["a subject padded with spaces", () => [{
        kind: "represents-principal",
        subject: ` ${bob.did()}`,
      }]],
      ["a subject padded with a newline", () => [{
        kind: "represents-principal",
        subject: `${bob.did()}\n`,
      }]],
      ["an extra key beside the placeholder subject", () => [{
        kind: "represents-principal",
        subject: CURRENT_PRINCIPAL,
        owner: bob.did(),
      }]],
      ["an author field beside the placeholder subject", () => [{
        kind: "authored-by",
        subject: CURRENT_PRINCIPAL,
        author: bob.did(),
      }]],
      ["a subject spelled in capitals", () => [{
        kind: "represents-principal",
        subject: bob.did().replace("did:", "DID:"),
      }]],
      ["a claim nested in another atom", () => [{
        type: "https://example.com/wrapper",
        inner: { kind: "represents-principal", subject: bob.did() },
      }]],
      ["the string form in a nested array", () => [[
        `represents-principal:${bob.did()}`,
      ]]],
      ["the string form in capitals", () => [
        `Represents-Principal:${bob.did()}`,
      ]],
      ["a forged atom beside a legitimate one", () => [
        { kind: "represents-principal", subject: CURRENT_PRINCIPAL },
        `represents-principal:${bob.did()}`,
      ]],
    ];

    it("refuses a pattern writing the string form with no write policy", async () => {
      // Without a placeholder there is nothing for writeAuthorizedBy and
      // uiContract to guard, so the bare schema is the cheapest forgery.
      const { error, principals } = await writeAsAlice(
        {
          type: "object",
          properties: {
            name: {
              type: "string",
              ifc: { addIntegrity: [`represents-principal:${bob.did()}`] },
            },
          },
          required: ["name"],
        } as JSONSchema,
        "represents-principal-writer-bare-string",
      );
      expect(principals).not.toContain(bob.did());
      expect(error).toContain("current-principal integrity");
    });

    for (const [name, atoms] of forgeries) {
      it(`refuses a pattern writing ${name} for another principal`, async () => {
        const { error, principals } = await writeAsAlice(
          claimSchema(atoms()),
          `represents-principal-writer-${name}`,
        );
        expect(principals).not.toContain(bob.did());
        expect(error).toContain("current-principal integrity");
      });
    }

    it("refuses an ownerPrincipal write that attests a second principal", async () => {
      const { error, principals } = await writeAsAlice(
        claimSchema([
          { kind: "represents-principal", subject: alice.did() },
          { kind: "represents-principal", subject: bob.did() },
        ], { ownerPrincipal: alice.did() }),
        "represents-principal-writer-owner-second",
      );
      expect(principals).not.toContain(bob.did());
      expect(error).toContain("current-principal integrity");
    });

    it("refuses a forged claim on the root while the write reaches a field", async () => {
      const { error, principals } = await writeAsAlice(
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          ifc: {
            addIntegrity: [
              { kind: "represents-principal", subject: CURRENT_PRINCIPAL },
              `represents-principal:${bob.did()}`,
            ],
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "/attacker.tsx",
                path: ["writeName"],
              },
            },
            uiContract,
          },
        } as JSONSchema,
        "represents-principal-writer-root",
      );
      expect(principals).not.toContain(bob.did());
      expect(error).toContain("current-principal integrity");
    });

    it("commits a literal subject that names no principal", async () => {
      // A demo can label its own message `authored-by` a made-up author; no
      // reader resolves that subject to a principal.
      const { error } = await writeAsAlice(
        claimSchema([{ kind: "authored-by", subject: "alice" }]),
        "represents-principal-writer-literal-name",
      );
      expect(error).toBeUndefined();
    });

    it("refuses an ownerPrincipal write whose only owner atom no reader reads", async () => {
      // The owner's atom nested inside another atom authorizes nothing: a
      // reader looks only at the atoms the label holds directly.
      const { error, principals } = await writeAsAlice(
        claimSchema([{
          type: "https://example.com/wrapper",
          inner: { kind: "represents-principal", subject: alice.did() },
        }], { ownerPrincipal: alice.did() }),
        "represents-principal-writer-owner-nested",
      );
      expect(principals).toEqual([]);
      expect(error).toContain("ownerPrincipal requires matching");
    });

    it("commits a self-attestation through the runtime placeholder", async () => {
      const { error, principals } = await writeAsAlice(
        claimSchema([{
          kind: "represents-principal",
          subject: CURRENT_PRINCIPAL,
        }]),
        "represents-principal-writer-self",
      );
      expect(error).toBeUndefined();
      expect(principals).toEqual([alice.did()]);
    });

    it("commits an ownerPrincipal self-attestation naming the owner literally", async () => {
      const { error, principals } = await writeAsAlice(
        claimSchema([{ kind: "represents-principal", subject: alice.did() }], {
          ownerPrincipal: alice.did(),
        }),
        "represents-principal-writer-owner-self",
      );
      expect(error).toBeUndefined();
      expect(principals).toEqual([alice.did()]);
    });
  });

  describe("on a link write", () => {
    // Alice's pattern commits a source document, then, in a second transaction,
    // writes into a new document the link `linkFor` builds to it. Returns the
    // principal claim subjects stored on the new document.
    const linkAsAlice = async (
      cause: string,
      sourceSchema: JSONSchema | undefined,
      linkFor: (source: ReturnType<Runtime["getCell"]>) => unknown,
    ) => {
      const { runtime, storageManager } = createRuntime();
      try {
        const seed = runtime.edit();
        actAsPatternFor(seed, alice.did());
        const source = runtime.getCell(
          alice.did(),
          `${cause}-source`,
          sourceSchema,
          seed,
        );
        source.set({ name: "Ada" });
        if (sourceSchema !== undefined) {
          recordTrustedEdit(seed, source.getAsNormalizedFullLink());
        }
        seed.prepareCfc();
        const seeded = await seed.commit();
        expect(seeded.error).toBeUndefined();

        const tx = runtime.edit();
        actAsPatternFor(tx, alice.did());
        const target = runtime.getCell(alice.did(), `${cause}-target`, {}, tx);
        target.set(linkFor(source) as never);
        tx.prepareCfc();
        const result = await tx.commit();
        return {
          error: result.error?.message,
          subjects: storedClaimSubjects(
            runtime,
            target.getAsNormalizedFullLink(),
          ),
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    const plainSource: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    const labeledSource: JSONSchema = {
      ...plainSource,
      ifc: { integrity: ["source-mark"] },
    } as JSONSchema;

    it("stores no claim a link's own schema names", async () => {
      const { error, subjects } = await linkAsAlice(
        "represents-principal-link-schema",
        labeledSource,
        (source) =>
          source.asSchema({
            ...plainSource,
            ifc: {
              integrity: ["harmless"],
              addIntegrity: [
                { kind: "represents-principal", subject: bob.did() },
                { kind: "authored-by", subject: bob.did() },
                { kind: "represents-principal", subject: CURRENT_PRINCIPAL },
              ],
            },
          } as JSONSchema),
      );
      expect(error).toBeUndefined();
      expect(subjects).not.toContain(bob.did());
      // The placeholder in a link schema is not a trusted edit either.
      expect(subjects).not.toContain(alice.did());
    });

    it("stores no claim a link's carried label view names", async () => {
      const { error, subjects } = await linkAsAlice(
        "represents-principal-link-view",
        labeledSource,
        (source) => {
          const link = source.getAsLink() as {
            "/": Record<string, Record<string, unknown>>;
          };
          link["/"][LINK_V1_TAG].cfcLabelView = {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [
                  "harmless",
                  { kind: "represents-principal", subject: bob.did() },
                ],
              },
            }, {
              path: ["name"],
              label: {
                integrity: [{ kind: "authored-by", subject: bob.did() }],
              },
            }],
          };
          return link;
        },
      );
      expect(error).toBeUndefined();
      expect(subjects).not.toContain(bob.did());
    });

    // A source schema whose field `p` names Bob, which no write ever reaches,
    // so the write check never looks at it.
    const unwrittenForgery: JSONSchema = {
      type: "object",
      properties: {
        q: { type: "string" },
        p: {
          type: "string",
          ifc: {
            addIntegrity: [
              { kind: "represents-principal", subject: bob.did() },
              { kind: "authored-by", subject: bob.did() },
            ],
          },
        },
      },
    } as JSONSchema;

    const profileTarget: JSONSchema = {
      type: "object",
      properties: { name: { type: "string" }, avatar: {} },
      ifc: { integrity: ["target-mark"] },
    } as JSONSchema;

    // In one transaction, Alice's pattern writes `source` through `prepare`,
    // then links its unwritten field `p` into a new profile-shaped document.
    const linkUnwrittenFieldAsAlice = async (
      cause: string,
      prepare: (
        tx: IExtendedStorageTransaction,
        runtime: Runtime,
      ) => ReturnType<Runtime["getCell"]>,
      linkPath: string,
    ) => {
      const { runtime, storageManager } = createRuntime();
      try {
        const tx = runtime.edit();
        actAsPatternFor(tx, alice.did());
        const source = prepare(tx, runtime);
        const target = runtime.getCell(
          alice.did(),
          `${cause}-target`,
          profileTarget,
          tx,
        );
        target.set({ name: "Bob", avatar: source.key(linkPath) } as never);
        tx.prepareCfc();
        const result = await tx.commit();
        return {
          error: result.error?.message,
          subjects: storedClaimSubjects(
            runtime,
            target.getAsNormalizedFullLink(),
          ),
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("stores no claim from a same-transaction source schema entry the write check skipped", async () => {
      const { subjects } = await linkUnwrittenFieldAsAlice(
        "represents-principal-link-pending",
        (tx, runtime) => {
          const source = runtime.getCell(
            alice.did(),
            "represents-principal-link-pending-source",
            unwrittenForgery,
            tx,
          );
          source.set({ q: "x" });
          return source;
        },
        "p",
      );
      expect(subjects).not.toContain(bob.did());
    });

    it("stores no claim from a source's setup result schema", async () => {
      const { subjects } = await linkUnwrittenFieldAsAlice(
        "represents-principal-link-setup",
        (tx, runtime) => {
          const source = runtime.getCell(
            alice.did(),
            "represents-principal-link-setup-source",
            undefined,
            tx,
          );
          source.set({ q: "x" });
          writeResultSchemaMeta(source.withTx(tx), unwrittenForgery);
          return source;
        },
        "p",
      );
      expect(subjects).not.toContain(bob.did());
    });

    it("carries a same-transaction source's checked self-attestation", async () => {
      const { error, subjects } = await linkUnwrittenFieldAsAlice(
        "represents-principal-link-pending-genuine",
        (tx, runtime) => {
          const source = runtime.getCell(
            alice.did(),
            "represents-principal-link-pending-genuine-source",
            claimSchema([{
              kind: "represents-principal",
              subject: CURRENT_PRINCIPAL,
            }]),
            tx,
          );
          source.set({ name: "Ada" });
          recordTrustedEdit(tx, source.getAsNormalizedFullLink());
          return source;
        },
        "name",
      );
      expect(error).toBeUndefined();
      expect(subjects).toContain(alice.did());
      expect(subjects).not.toContain(bob.did());
    });

    it("refuses a link to an unlabeled source whose carried view holds only claims", async () => {
      // With the claims gone the view carries nothing, so the link must meet
      // the same refusal as one that carries no view.
      const { error, subjects } = await linkAsAlice(
        "represents-principal-link-view-only-claims",
        undefined,
        (source) => {
          const link = source.getAsLink() as {
            "/": Record<string, Record<string, unknown>>;
          };
          link["/"][LINK_V1_TAG].cfcLabelView = {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [{
                  kind: "represents-principal",
                  subject: bob.did(),
                }],
              },
            }],
          };
          return link;
        },
      );
      expect(subjects).not.toContain(bob.did());
      expect(error).toContain("missing link source metadata");
    });

    it("carries the claim the source's own stored label holds", async () => {
      const { error, subjects } = await linkAsAlice(
        "represents-principal-link-genuine",
        claimSchema([{
          kind: "represents-principal",
          subject: CURRENT_PRINCIPAL,
        }]),
        (source) => source.key("name"),
      );
      expect(error).toBeUndefined();
      expect(subjects).toEqual([alice.did()]);
    });
  });
});
