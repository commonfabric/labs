import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON } from "../src/cfc/migration-reason.ts";
import { NAME, UI } from "../src/builder/types.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";

// Why: reproduces the live Estuary "home stays bricked" incident's next layer.
// The cold-start-setup-repair materializes the real home pattern over a home
// root doc that predates some of home's fields, and CFC schema-merge's
// additive-required guard ("required field <name> needs a default to preserve
// old documents") refused the setup commit. #4933 defaulted six data fields,
// but a result projection can also contain required fields for which a
// migration default is not the right contract. The relevant distinction is
// provenance: setup rewrites the complete generated result, while ordinary
// document paths must still preserve older values.
//
// These tests take the CFC enforcement rung the runtime carries. The
// additive-required guard runs inside schema merge, which every enforcing rung
// reaches before its own checks, so the setup commit's fate is the same across
// them. The piece cold-start harness runs with enforcement disabled, which is
// why #4926/#4933's tests were blind to this layer.

const alice = await Identity.fromPassphrase(
  "cfc-additive-default-preserves-old-doc-alice",
);

const OWNER_WRITER = "system.legacy-home";

const ownerProtectedString = (ownerDid: string): JSONSchema => ({
  type: "string",
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [{ kind: "represents-principal", subject: ownerDid }],
    writeAuthorizedBy: [OWNER_WRITER],
  },
});

// A labeled field that makes a root cfc-relevant, with stored CFC metadata,
// and names no writer.
const labeledOwnerString: JSONSchema = {
  type: "string",
  ifc: { confidentiality: ["legacy-home-owner"] },
};

// A realistic pre-favorites home root: it once ran a home setup, so it carries
// the primordial framework projection keys ($NAME/$UI) and an `owner` field
// that makes the root cfc-relevant (stored CFC metadata), but it predates
// favorites and the handlers that shipped with it — exactly the vintage whose
// repair throws additive-required. `owner` is owner-protected unless the
// caller passes another schema for it.
const legacyHomeSchema = (
  ownerDid: string,
  owner: JSONSchema = ownerProtectedString(ownerDid),
): JSONSchema => ({
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    [UI]: { type: "unknown" },
    owner,
  },
  required: [NAME, UI, "owner"],
});

/**
 * Seeds `root` as a legacy home whose `owner` field is typed `owner`, as its
 * named writer, then materializes the real home pattern over it.
 */
const materializeHomeOverLegacyRoot = async (
  runtime: Runtime,
  space: ReturnType<typeof alice.did>,
  root: string,
  owner: JSONSchema,
) => {
  const tx = runtime.edit();
  tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
  tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: OWNER_WRITER });
  const cell = runtime.getCell(space, root, legacyHomeSchema(space, owner), tx);
  cell.set({
    [NAME]: "Legacy Home (pre-setup)",
    [UI]: null,
    owner: "alice",
  });
  const target = cell.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path: ["owner"],
    },
    eventId: "seed-owner",
    provenance: { origin: "dom", trusted: true },
  });
  tx.prepareCfc();
  expect((await tx.commit()).ok).toBeDefined();

  const homePattern = await compileHomePattern(runtime, space);
  const home = await runtime.runSynced(
    runtime.getCell(space, root),
    homePattern,
    {},
  );
  await home.pull();
  await runtime.idle();
  return home;
};

const compileHomePattern = async (
  runtime: Runtime,
  space: ReturnType<typeof alice.did>,
) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath = new URL(
    "../../patterns/system/home.tsx",
    import.meta.url,
  ).pathname;
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: sourcePath, root: repoRoot },
  );
  return await runtime.patternManager.compilePattern(program, { space });
};

describe("CFC additive-required default preserves old documents", () => {
  //
  // Tight pin on the guard itself
  //
  // A generated output does not need a default, while an unclassified document
  // field still does. This isolates the role-aware schema-merge rule from the
  // full home compile.
  //

  it("exempts an additive-required generated output from the default requirement", () => {
    const stored: JSONSchema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const candidate: JSONSchema = {
      type: "object",
      properties: {
        owner: { type: "string" },
        // A handler stream slot, exactly as the schema-generator emits home's
        // exported handlers.
        addFavorite: {
          type: "object",
          properties: {},
          asCell: ["stream"],
        },
      },
      required: ["owner", "addFavorite"],
    };
    const merged = mergeCfcSchemaEnvelopes(stored, candidate, {
      generatedOutputPaths: [[]],
    }) as JSONSchemaObj;
    expect(merged.required).toContain("addFavorite");
  });

  it("still rejects an additive-required plain data field without a default", () => {
    const stored: JSONSchema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const candidate: JSONSchema = {
      type: "object",
      properties: {
        owner: { type: "string" },
        title: { type: "string" },
      },
      required: ["owner", "title"],
    };
    expect(() => mergeCfcSchemaEnvelopes(stored, candidate)).toThrow(
      /required field title needs a default/,
    );
  });

  //
  // The same rule end to end
  //

  it("materializes the real home pattern over a pre-favorites root under enforcement", async () => {
    // Faithful end-to-end: run the real home pattern's setup over a realistic
    // old home root, with enforcement ON. Before the fix, the setup commit is
    // rejected (defaultProfile, then the handler streams). After the fix it
    // commits and the home heals. The root's `owner` field carries a label
    // and no writer claim, so the only thing that could refuse the setup is
    // the additive-required guard under test.

    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const home = await materializeHomeOverLegacyRoot(
        runtime,
        alice.did(),
        "legacy-home-root",
        labeledOwnerString,
      );

      // Discriminator: the setup projection only overwrites the root's $NAME
      // with the pattern's "Home" if its commit actually LANDED. When the
      // additive-required guard rejects the commit, the transaction aborts and
      // the seeded legacy name survives — so this assertion fails exactly when
      // the setup was refused (the reproduced bricked-home behavior).
      expect(home.key(NAME).get()).toBe("Home");
      // And favorites materialized to its defaulted empty list.
      const favorites = home.key("favorites");
      expect(favorites.get() ?? []).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses a home setup that would drop a writer-protected path", async () => {
    // The home pattern declares no `owner`, so its setup rewrite of the whole
    // result deletes the field, and only the field's named writer may.

    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const home = await materializeHomeOverLegacyRoot(
        runtime,
        alice.did(),
        "legacy-home-root-protected-owner",
        ownerProtectedString(alice.did()),
      );

      expect(home.key(NAME).get()).toBe("Legacy Home (pre-setup)");
      expect(home.key("owner" as never).get()).toBe("alice");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("frames a real additive-required-no-default commit rejection with the migration token", async () => {
    // The producer→consumer token contract, end to end at the runner layer:
    // mergeRequired throws CfcSchemaMigrationError → the prepare catch records
    // it as a TAGGED reason → the COMMIT rejection message carries the framed
    // `: <token>: ` the piece backstop keys on. The piece tests synthesize this
    // string; this test proves the runner actually produces it, so the two ends
    // stay in lockstep if either side's wording drifts.

    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const space = alice.did();
    const ROOT = "legacy-home-root-reject";
    const seedMeta = (tx: ReturnType<typeof runtime.edit>) => {
      tx.setCfcTrustSnapshot({ id: `trust-${space}`, actingPrincipal: space });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: OWNER_WRITER,
      });
    };
    try {
      // 1. Seed a cfc-relevant root under a schema requiring [NAME, UI, owner].
      {
        const tx = runtime.edit();
        seedMeta(tx);
        const cell = runtime.getCell(space, ROOT, legacyHomeSchema(space), tx);
        cell.set({ [NAME]: "Legacy", [UI]: null, owner: "alice" });
        const target = cell.getAsNormalizedFullLink();
        tx.recordCfcWritePolicyInput({
          kind: "trusted-event",
          target: {
            space: target.space,
            scope: target.scope,
            id: target.id,
            path: ["owner"],
          },
          eventId: "seed-owner",
          provenance: { origin: "dom", trusted: true },
        });
        tx.prepareCfc();
        expect((await tx.commit()).ok).toBeDefined();
      }

      // 2. Re-commit the same root under a schema that ADDS a required field
      //    with NO default — the additive-required migration the guard refuses.
      const augmented: JSONSchema = {
        type: "object",
        properties: {
          [NAME]: { type: "string" },
          [UI]: { type: "unknown" },
          owner: ownerProtectedString(space),
          secret: { type: "string" },
        },
        required: [NAME, UI, "owner", "secret"],
      };
      const tx = runtime.edit();
      seedMeta(tx);
      const cell = runtime.getCell(space, ROOT, augmented, tx);
      cell.set({ [NAME]: "Legacy", [UI]: null, owner: "alice", secret: "x" });
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: ["owner"],
        },
        eventId: "reject-owner",
        provenance: { origin: "dom", trusted: true },
      });
      tx.prepareCfc();
      const res = await tx.commit();

      // Rejected — and the message carries the FRAMED token (not a bare
      // occurrence), exactly what `isCfcMigrationRejection` matches.
      expect(res.error).toBeDefined();
      const message = res.error?.message ?? "";
      expect(message).toContain("CFC enforcement rejected commit");
      expect(message).toContain(
        `: ${CFC_SCHEMA_MIGRATION_INCOMPATIBLE_REASON}: `,
      );
      expect(message).toContain("required field secret needs a default");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
