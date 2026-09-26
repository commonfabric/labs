import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  type NormalizedFullLink,
  toMemorySpaceAddress,
} from "../src/link-utils.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const alice = await Identity.fromPassphrase(
  "runner-profile-owner-cfc-alice",
);
const bob = await Identity.fromPassphrase("runner-profile-owner-cfc-bob");

const PROFILE_WRITER = "system.profile-home";

const ownerAtom = (ownerDid: string) => ({
  kind: "represents-principal",
  subject: ownerDid,
});

const ownerProtectedString = (ownerDid: string): JSONSchema => ({
  type: "string",
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [ownerAtom(ownerDid)],
    writeAuthorizedBy: [PROFILE_WRITER],
    uiContract: {
      helper: "UiAction",
      action: "EditProfile",
      trustedPattern: "ProfileHome",
      requiredEventIntegrity: ["ProfileHome"],
    },
  },
});

const ownerProtectedElements = (ownerDid: string): JSONSchema => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      tag: { type: "string" },
      userTags: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [ownerAtom(ownerDid)],
    writeAuthorizedBy: [PROFILE_WRITER],
    uiContract: {
      helper: "UiAction",
      action: "EditProfile",
      trustedPattern: "ProfileHome",
      requiredEventIntegrity: ["ProfileHome"],
    },
  },
});

const profileSchema = (ownerDid: string): JSONSchema => ({
  type: "object",
  properties: {
    name: ownerProtectedString(ownerDid),
    avatar: ownerProtectedString(ownerDid),
    elements: ownerProtectedElements(ownerDid),
  },
  required: ["name", "avatar", "elements"],
});

const createRuntime = () => {
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  return { runtime, storageManager };
};

const compileHomePattern = async (runtime: Runtime) => {
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
  return await runtime.patternManager.compilePattern(program);
};

const compileProfileHomePattern = async (runtime: Runtime) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath = new URL(
    "../../patterns/system/profile-home.tsx",
    import.meta.url,
  ).pathname;
  const program = await resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: sourcePath, root: repoRoot },
  );
  return await runtime.patternManager.compilePattern(program);
};

const resolveLocalSchemaRef = (root: JSONSchema, schema: JSONSchema) => {
  const ref = (schema as { $ref?: string }).$ref;
  if (!ref?.startsWith("#/$defs/")) {
    return schema;
  }
  const defName = ref.slice("#/$defs/".length);
  const definition = (root as { $defs?: Record<string, JSONSchema> }).$defs?.[
    defName
  ];
  if (
    !definition || typeof definition !== "object" ||
    typeof schema !== "object"
  ) return definition ?? schema;
  const { $ref: _ref, ...siblings } = schema as Record<string, unknown>;
  return resolveLocalSchemaRef(root, {
    ...(definition as Record<string, unknown>),
    ...siblings,
  } as JSONSchema);
};

const setTrustedProfileWriter = (
  tx: IExtendedStorageTransaction,
  actingPrincipal?: string,
) => {
  if (actingPrincipal !== undefined) {
    setCfcTrustSnapshot(tx, {
      id: `profile-trust-${actingPrincipal}`,
      actingPrincipal,
    });
  }
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: PROFILE_WRITER,
  });
};

const recordTrustedEdit = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  path: string[],
) => {
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path,
    },
    eventId: `trusted-profile-edit-${path.join("-")}`,
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

describe("profile owner CFC policy", () => {
  it("persists Alice owner integrity on profile default fields", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, alice.did());

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-alice",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: target.space,
        scope: target.scope,
        id: target.id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["name"],
        label: { integrity: [ownerAtom(alice.did())] },
        origin: "declared",
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["avatar"],
        label: { integrity: [ownerAtom(alice.did())] },
        origin: "declared",
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["elements"],
        label: { integrity: [ownerAtom(alice.did())] },
        origin: "declared",
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps an authorized write valid after a later same-tx run changes the implementation identity", async () => {
    // Mirrors running a child pattern inline in the same transaction: the
    // handler authorizes a protected write under its identity, then a later run
    // changes the transaction's implementation identity. The earlier write was
    // valid when made and must stay valid — CFC must verify each write against
    // the identity that was active when it was recorded, not the last one.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, alice.did());
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-identity-clobber",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      // A second run in the same transaction (e.g. an inline child pattern)
      // changes the transaction-level implementation identity.
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "system.unrelated-writer",
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects Bob writing Alice's protected profile fields", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seededCell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-bob-rejected",
        profileSchema(alice.did()),
        seed,
      );
      seededCell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = seededCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["name"]);
      recordTrustedEdit(seed, target, ["avatar"]);
      recordTrustedEdit(seed, target, ["elements"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      setTrustedProfileWriter(tx, bob.did());
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-bob-rejected",
        profileSchema(alice.did()),
        tx,
      );
      cell.key("name").set("Mallory");
      recordTrustedEdit(tx, target, ["name"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A mergeable array op (add-unique / remove-by-value) records the same schema
  // write-policy input and produces the same array-path write as a whole-value
  // `set`, so the owner-write authorization applies to it unchanged. An
  // owner-protected string list keeps the assertion on the op itself, not on the
  // keyed-entity machinery.
  const ownerProtectedTagList = (ownerDid: string): JSONSchema => ({
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        ifc: {
          ownerPrincipal: ownerDid,
          addIntegrity: [ownerAtom(ownerDid)],
          writeAuthorizedBy: [PROFILE_WRITER],
          uiContract: {
            helper: "UiAction",
            action: "EditProfile",
            trustedPattern: "ProfileHome",
            requiredEventIntegrity: ["ProfileHome"],
          },
        },
      },
    },
    required: ["tags"],
  });

  it("authorizes mergeable add-unique and remove-by-value on an owner-protected list", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = ownerProtectedTagList(alice.did());
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seedCell = runtime.getCell(
        alice.did(),
        "cfc-mergeable-list",
        schema,
        seed,
      );
      seedCell.set({ tags: [] });
      const target = seedCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["tags"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // The authorized writer adds through the mergeable op.
      const add = runtime.edit();
      setTrustedProfileWriter(add, alice.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list", schema, add)
        .key("tags").addUnique("x");
      recordTrustedEdit(add, target, ["tags"]);
      add.prepareCfc();
      expect((await add.commit()).error).toBeUndefined();

      // ...and removes through the mergeable op.
      const rm = runtime.edit();
      setTrustedProfileWriter(rm, alice.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list", schema, rm)
        .key("tags").removeByValue("x");
      recordTrustedEdit(rm, target, ["tags"]);
      rm.prepareCfc();
      expect((await rm.commit()).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an unauthorized mergeable write to an owner-protected list", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = ownerProtectedTagList(alice.did());
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seedCell = runtime.getCell(
        alice.did(),
        "cfc-mergeable-list-rejected",
        schema,
        seed,
      );
      seedCell.set({ tags: [] });
      const target = seedCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["tags"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // Bob add-uniques to Alice's owner-protected list: the mergeable op is
      // gated by the same ownerPrincipal check as a whole-value set.
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, bob.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list-rejected", schema, tx)
        .key("tags").addUnique("x");
      recordTrustedEdit(tx, target, ["tags"]);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects unauthenticated owner-protected profile writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, undefined);
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: PROFILE_WRITER,
      });
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-unauthenticated",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects untrusted owner-protected profile writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "profile-trust-untrusted",
        actingPrincipal: alice.did(),
      });

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-untrusted",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects ownerPrincipal schemas without matching integrity claims", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "profile-trust-owner-without-integrity",
        actingPrincipal: alice.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: PROFILE_WRITER,
      });

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-without-integrity",
        {
          type: "object",
          properties: {
            name: {
              type: "string",
              ifc: {
                ownerPrincipal: alice.did(),
                writeAuthorizedBy: [PROFILE_WRITER],
              },
            },
          },
          required: ["name"],
        },
        tx,
      );
      cell.set({ name: "Ada" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks the home profiles list as integrity-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      // Protection lives on the array *elements* (TrustedProfileLink), not the
      // array container — so resolve `profiles.items` and assert there.
      const profilesSchema = resolveLocalSchemaRef(
        rootSchema,
        (rootSchema as { properties?: Record<string, JSONSchema> }).properties
          ?.profiles ?? {},
      ) as { type?: string; items?: JSONSchema };
      expect(profilesSchema.type).toBe("array");
      const itemSchema = resolveLocalSchemaRef(
        rootSchema,
        profilesSchema.items ?? {},
      ) as { ifc?: { addIntegrity?: unknown[]; writeAuthorizedBy?: unknown } };
      expect(itemSchema.ifc?.addIntegrity).toContain("profile-link");
      expect(itemSchema.ifc?.writeAuthorizedBy).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks production profile fields as owner-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const profileHomePattern = await compileProfileHomePattern(runtime);
      const rootSchema = profileHomePattern.resultSchema as JSONSchema;
      const properties =
        (rootSchema as { properties?: Record<string, JSONSchema> })
          .properties ?? {};

      for (
        const field of [
          "name",
          "avatar",
          "externalLinks",
          "verifiedIdentities",
          "elements",
        ]
      ) {
        const fieldSchema = resolveLocalSchemaRef(
          rootSchema,
          properties[field],
        );
        const ifc = (fieldSchema as { ifc?: Record<string, unknown> }).ifc;
        expect(ifc?.ownerPrincipal).toEqual({
          __ctCurrentPrincipal: true,
        });
        expect(ifc?.addIntegrity).toContainEqual({
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        });
        expect(ifc?.writeAuthorizedBy).toBeDefined();
      }

      const verifiedIdentitiesSchema = resolveLocalSchemaRef(
        rootSchema,
        properties.verifiedIdentities,
      ) as { type?: string; items?: JSONSchema };
      expect(verifiedIdentitiesSchema.type).toBe("array");
      const verifiedIdentitySchema = resolveLocalSchemaRef(
        rootSchema,
        verifiedIdentitiesSchema.items ?? {},
      ) as {
        asCell?: unknown[];
        ifc?: { addIntegrity?: unknown[]; requiredIntegrity?: unknown[] };
      };
      // The pattern spells the atom out; this pins it to the constant the
      // runtime's mint gate lists, so the two cannot drift apart.
      expect(verifiedIdentitySchema.ifc?.requiredIntegrity).toContain(
        CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM,
      );
      expect(verifiedIdentitySchema.ifc?.addIntegrity).not.toContain(
        CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM,
      );

      const publishSchema = resolveLocalSchemaRef(
        rootSchema,
        properties.publishVerifiedIdentities,
      ) as { properties?: Record<string, JSONSchema> };
      const publishedIdentities = resolveLocalSchemaRef(
        rootSchema,
        publishSchema.properties?.identities ?? {},
      ) as { items?: JSONSchema };
      const publishedIdentity = resolveLocalSchemaRef(
        rootSchema,
        publishedIdentities.items ?? {},
      ) as {
        ifc?: { requiredIntegrity?: unknown[] };
      };
      expect(publishedIdentity.ifc?.requiredIntegrity).toContain(
        CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM,
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows a pattern to initialize its own owner-protected result fields during creation", async () => {
    // Reproduces the pattern-creation gap: instantiating a pattern whose result
    // declares owner-protected fields (writeAuthorizedBy bound to its own edit
    // handlers) means the runtime must project and initialize those fields
    // (avatar = "", elements = []). That trusted initialization is authored by
    // the creating context, which is NOT any of the per-field edit handlers, so
    // the writeAuthorizedBy modification gate rejects the pattern's own setup.
    // This is independent of cross-space: the same happens same-space for any
    // `aCell.set(SomePattern({}))` creation flow.
    const { runtime, storageManager } = createRuntime();
    try {
      const profileHomePattern = await compileProfileHomePattern(runtime);
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "pattern-create",
        actingPrincipal: alice.did(),
      });
      // The creating context (e.g. a profile-create handler) is not the
      // per-field edit handler (setName/setAvatar/addElement).
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "system.profile-create",
      });
      const resultCell = runtime.getCell(
        alice.did(),
        "pattern-create-owner-init",
        profileHomePattern.resultSchema,
        tx,
      );
      runtime.runner.run(
        tx,
        profileHomePattern,
        { initialName: "Ada" },
        resultCell,
      );
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects direct untrusted writes to the home profiles list", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const tx = runtime.edit();
      runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted",
        homePattern.resultSchema,
        tx,
      );
      const profileDefault = runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted-target",
        undefined,
        tx,
      );
      profileDefault.set({
        name: "Ada",
        avatar: "",
        elements: [],
      });
      await tx.commit();

      const writeTx = runtime.edit();
      const protectedHomeDefault = runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted",
        homePattern.resultSchema,
        writeTx,
      );
      protectedHomeDefault.key("profiles").set([profileDefault]);
      writeTx.prepareCfc();
      const result = await writeTx.commit();
      expect(result.error?.message).toContain("trusted");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects untrusted truncation/removal of the home profiles list", async () => {
    // Element-level protection only gates *changed* elements of the new array,
    // so a shrink (set([]) / dropping an entry) would otherwise be unmediated.
    // The container-level writeAuthorizedBy must reject it.
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      // The list starts non-empty, so that the write below is the shrink this
      // case is named for. The container's `writeAuthorizedBy` names a
      // verified handler in `profile-create.tsx`, which no transaction this
      // test can author under, so the seed goes in through the raw document
      // address: a write that names no schema records no write-policy input,
      // and the gate under test does not decide it.
      const seed = runtime.edit();
      const profileA = runtime.getCell(
        alice.did(),
        "home-profiles-truncate-A",
        undefined,
        seed,
      );
      profileA.set({ name: "Ada", avatar: "", elements: [] });
      const home = runtime.getCell(
        alice.did(),
        "home-profiles-truncate",
        homePattern.resultSchema,
        seed,
      );
      const storedProfiles = toMemorySpaceAddress(
        home.key("profiles").getAsNormalizedFullLink(),
      );
      seed.writeOrThrow(storedProfiles, [profileA.getAsLink()]);
      expect((await seed.commit()).error).toBeUndefined();

      // Untrusted truncation under enforcement → rejected by the container
      // writeAuthorizedBy (the array value changed [A] -> []).
      const writeTx = runtime.edit();
      const protectedHome = runtime.getCell(
        alice.did(),
        "home-profiles-truncate",
        homePattern.resultSchema,
        writeTx,
      );
      // The stored list holds the seeded entry, so the write below empties it.
      expect(writeTx.readOrThrow(storedProfiles)).toHaveLength(1);
      protectedHome.key("profiles").set([]);
      writeTx.prepareCfc();
      const result = await writeTx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity " +
          "at /profiles",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not expose a writable profile creation trigger", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const properties =
        (homePattern.resultSchema as { properties?: Record<string, unknown> })
          .properties ?? {};
      expect(properties.requestedProfileName).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows initializing owner-protected fields marked as a pattern setup projection", async () => {
    // When the runtime instantiates a pattern whose result declares
    // owner-protected fields, it records a `runtime.setup.result-projection`
    // marker whose `sources` point at the cells holding those fields. A creating
    // context that is not the per-field edit handler may then initialize them:
    // `writeAuthorizedBy` is a modification gate, not a creation gate (CFC spec
    // §8.15.4 / §8.15.10). This exercises that exemption directly: an identity
    // that does NOT satisfy `writeAuthorizedBy` is allowed solely because the
    // owner-protected fields are recorded as this pattern's setup projection.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "setup-projection",
        actingPrincipal: alice.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "system.not-the-profile-writer",
      });
      const cell = runtime.getCell(
        alice.did(),
        "owner-init-setup-projection",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);
      // The pattern's result cell redirects these owner-protected fields to
      // `cell`; record the trusted setup-projection marker with `cell` as the
      // redirect source, as the runtime does during instantiation.
      const resultCell = runtime.getCell(
        alice.did(),
        "owner-init-setup-projection-result",
        undefined,
        tx,
      );
      const resultTarget = resultCell.getAsNormalizedFullLink();
      for (const path of [["name"], ["avatar"], ["elements"]]) {
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: resultTarget.space,
            scope: resultTarget.scope,
            id: resultTarget.id,
            path,
          },
          claim: "runtime.setup.result-projection",
          sources: [{
            space: target.space,
            scope: target.scope,
            id: target.id,
            path,
          }],
        });
      }
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the same owner-protected write without a setup-projection marker", async () => {
    // Negative twin of the test above: identical write under a non-writer
    // identity, but WITHOUT recording the setup-projection marker. Proves the
    // marker is load-bearing — the exemption is not an unconditional bypass.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "no-marker",
        actingPrincipal: alice.did(),
      });
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "system.not-the-profile-writer",
      });
      const cell = runtime.getCell(
        alice.did(),
        "owner-init-no-marker",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);
      // No setup-projection marker recorded.
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("verifies writeAuthorizedBy per field against the authoring identity", async () => {
    // Two protected fields on one cell, each authorized by a different builtin,
    // written under their respective identities. writeAuthorizedBy must be
    // verified per field against the identity that authored that field's write,
    // not collapsed to the first identity seen for the cell.
    const twoFieldSchema: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "string", ifc: { writeAuthorizedBy: ["writer.x"] } },
        y: { type: "string", ifc: { writeAuthorizedBy: ["writer.y"] } },
      },
      required: ["x", "y"],
    };
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, { id: "per-path", actingPrincipal: alice.did() });
      const cell = runtime.getCell(
        alice.did(),
        "per-path-identity",
        twoFieldSchema,
        tx,
      );
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "writer.x",
      });
      cell.key("x").set("vx");
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "writer.y",
      });
      cell.key("y").set("vy");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a field written under another field's authorized identity", async () => {
    // Field y written under writer.x (authorized only for x). Must be rejected:
    // the per-field identity must not be borrowed from another field's write.
    const twoFieldSchema: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "string", ifc: { writeAuthorizedBy: ["writer.x"] } },
        y: { type: "string", ifc: { writeAuthorizedBy: ["writer.y"] } },
      },
      required: ["x", "y"],
    };
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setCfcTrustSnapshot(tx, {
        id: "per-path-neg",
        actingPrincipal: alice.did(),
      });
      const cell = runtime.getCell(
        alice.did(),
        "per-path-identity-neg",
        twoFieldSchema,
        tx,
      );
      // Both fields written under writer.x; y is not authorized for writer.x.
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "writer.x",
      });
      cell.key("x").set("vx");
      cell.key("y").set("vy");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
