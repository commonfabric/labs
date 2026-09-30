import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { applyCfcPolicyToExistingValue } from "../src/cfc/policy-application.ts";
import {
  loadStoredCfcEnvelope,
  releaseMergeOptions,
  storedCfcEnvelopeMergeIssue,
} from "../src/cfc/prepare.ts";
import {
  type ImplementationIdentity,
  runtimeWritePolicyAuthorization,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";

const signer = await Identity.fromPassphrase("runner-cfc-stamp-adoption");
const space = signer.did();

// The aged claim: stored before writer stamps existed, spelled by a compile
// rooted at the patterns directory.
const AGED_FILE = "/system/profile.tsx";
// The release's claim for the same export, spelled below a labs checkout and
// stamped with the module it names.
const RELEASE_FILE = "/packages/patterns/system/profile.tsx";
const PROFILE_MODULE = "profile-module";

const claim = (file: string, moduleIdentity?: string) => ({
  __ctWriterIdentityOf: {
    file,
    path: ["setName"],
    ...(moduleIdentity !== undefined && { moduleIdentity }),
  },
});

const schemaWith = (
  writeAuthorizedBy: ReturnType<typeof claim>,
) =>
  ({
    type: "object",
    properties: {
      name: { type: "string", ifc: { writeAuthorizedBy } },
      other: { type: "string" },
    },
    ifc: { confidentiality: ["owner-clause"] },
  }) as JSONSchema;

describe("adopting an unstamped writer claim", () => {
  // A stamped claim adopts an unstamped stored one spelled below another
  // pattern root only when the stamp is one the transaction may vouch for: a
  // module of the program a release of the piece installs, or the writer the
  // stamp names. Any other writer's schema carrying a stamp leaves the stored
  // claim as it is, and the merge refuses.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const trust = (tx: IExtendedStorageTransaction) =>
    setCfcTrustSnapshot(tx, { id: `trust-${space}`, actingPrincipal: space });

  // Stores `{name, other}` under an unstamped claim at `name`. A host's
  // policy application is how a claim comes to rest over a value nobody who
  // could satisfy it wrote.
  const start = async (id: string): Promise<Runtime> => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    {
      const tx = runtime.edit();
      trust(tx);
      runtime.getCell(space, id, {
        type: "object",
        ifc: { confidentiality: ["owner-clause"] },
      }, tx).set({ name: "n", other: "o" } as never);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const tx = runtime.edit();
    trust(tx);
    setCfcImplementationIdentity(tx, { kind: "builtin", builtinId: "host" });
    applyCfcPolicyToExistingValue(
      runtime.getCell(space, id, schemaWith(claim(AGED_FILE)), tx),
    );
    expect((await tx.commit()).error).toBeUndefined();
    expect(storedNameClaim(runtime, id)).toEqual(claim(AGED_FILE));
    return runtime;
  };

  const storedNameClaim = (runtime: Runtime, id: string) => {
    const tx = runtime.edit();
    const envelope = loadStoredCfcEnvelope(tx, {
      space,
      id: runtime.getCell(space, id).getAsNormalizedFullLink().id,
      scope: undefined,
    } as never);
    tx.abort();
    return (envelope as {
      schema?: {
        properties?: { name?: { ifc?: { writeAuthorizedBy?: unknown } } };
      };
    }).schema?.properties?.name?.ifc?.writeAuthorizedBy;
  };

  // What the runtime records in the transaction that sets a piece up: the
  // release marker naming the modules of the program it installs.
  const markRelease = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    id: string,
    modules: readonly string[],
  ) => {
    const target = runtime.getCell(space, id).getAsNormalizedFullLink();
    const address = {
      space: target.space,
      id: target.id,
      scope: target.scope,
      path: [],
    };
    tx.recordCfcWritePolicyInput({
      kind: "release-program",
      target: address,
      modules,
    }, runtimeWritePolicyAuthorization);
  };

  // A write beside the claimed field, through a schema that stamps the claim.
  const writeOtherUnder = (
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    id: string,
    stamped: ReturnType<typeof claim>,
  ) =>
    runtime.getCell(space, id, schemaWith(stamped), tx).update(
      { other: "changed" } as never,
    );

  const refusalOf = (result: { error?: unknown }): string => {
    const error = result.error as Error | undefined;
    expect(isCfcEnforcementRejection(error)).toBe(true);
    return String(error?.message);
  };

  it("adopts a stamp from the program a release installs, and the stamped writer then writes the field", async () => {
    const runtime = await start("release-adopts");
    const release = runtime.edit();
    trust(release);
    markRelease(runtime, release, "release-adopts", [
      "home-module",
      PROFILE_MODULE,
    ]);
    writeOtherUnder(
      runtime,
      release,
      "release-adopts",
      claim(RELEASE_FILE, PROFILE_MODULE),
    );
    expect((await release.commit()).error).toBeUndefined();
    expect(storedNameClaim(runtime, "release-adopts")).toEqual(
      claim(RELEASE_FILE, PROFILE_MODULE),
    );

    const write = runtime.edit();
    trust(write);
    setCfcImplementationIdentity(write, {
      kind: "verified",
      moduleIdentity: PROFILE_MODULE,
      sourceFile: RELEASE_FILE,
      bindingPath: ["setName"],
    });
    runtime.getCell(
      space,
      "release-adopts",
      schemaWith(claim(RELEASE_FILE, PROFILE_MODULE)),
      write,
    ).key("name").set("renamed" as never);
    expect((await write.commit()).error).toBeUndefined();
  });

  it("refuses, in a release, a stamp from a module outside its program", async () => {
    // A hand-written stamp in a pattern's schema naming a module the pattern
    // does not import is one such stamp.
    const runtime = await start("release-foreign");
    const release = runtime.edit();
    trust(release);
    markRelease(runtime, release, "release-foreign", ["home-module"]);
    writeOtherUnder(
      runtime,
      release,
      "release-foreign",
      claim(RELEASE_FILE, "foreign-module"),
    );
    expect(refusalOf(await release.commit())).toContain(
      "writeAuthorizedBy must remain stable at /name",
    );
    expect(storedNameClaim(runtime, "release-foreign")).toEqual(
      claim(AGED_FILE),
    );
  });

  it("refuses a program named without the runtime's authorization", async () => {
    const runtime = await start("forged-program");
    const tx = runtime.edit();
    trust(tx);
    const target = runtime.getCell(space, "forged-program")
      .getAsNormalizedFullLink();
    tx.recordCfcWritePolicyInput({
      kind: "release-program",
      target: {
        space: target.space,
        id: target.id,
        scope: target.scope,
        path: [],
      },
      modules: [PROFILE_MODULE],
    });
    writeOtherUnder(
      runtime,
      tx,
      "forged-program",
      claim(RELEASE_FILE, PROFILE_MODULE),
    );
    expect(refusalOf(await tx.commit())).toContain(
      "writeAuthorizedBy must remain stable at /name",
    );
  });

  const THIRD_PATTERN: ImplementationIdentity = {
    kind: "verified",
    moduleIdentity: "third-module",
    sourceFile: "/packages/patterns/third.tsx",
    bindingPath: ["write"],
  };
  for (
    const [name, identity] of [
      ["an unattributed writer", undefined],
      [
        "a third pattern that imports the stamped module's types",
        THIRD_PATTERN,
      ],
    ] as const
  ) {
    it(`refuses ${name} carrying the stamp in a write beside the field`, async () => {
      const id = `sibling-${name}`;
      const runtime = await start(id);
      const tx = runtime.edit();
      trust(tx);
      if (identity !== undefined) setCfcImplementationIdentity(tx, identity);
      writeOtherUnder(runtime, tx, id, claim(RELEASE_FILE, PROFILE_MODULE));
      expect(refusalOf(await tx.commit())).toContain(
        "writeAuthorizedBy must remain stable at /name",
      );
      expect(storedNameClaim(runtime, id)).toEqual(claim(AGED_FILE));
    });
  }

  it("judges a release in the setsrc preflight as the release's commit does", async () => {
    // The preflight gates the release it predicts, so it merges with the
    // release's options: the program's stamp adopts, a foreign one doesn't.
    const runtime = await start("preflight");
    const tx = runtime.readTx();
    const link = runtime.getCell(space, "preflight").getAsNormalizedFullLink();
    const target = { space: link.space, id: link.id, scope: link.scope };
    const stored = loadStoredCfcEnvelope(tx, target);
    expect(stored.status).toBe("loaded");
    const storedSchema = (stored as { schema: JSONSchema }).schema;
    const candidate = schemaWith(claim(RELEASE_FILE, PROFILE_MODULE));
    expect(
      storedCfcEnvelopeMergeIssue(
        storedSchema,
        candidate,
        releaseMergeOptions(tx, target, storedSchema, [PROFILE_MODULE]),
      ),
    ).toBeUndefined();
    expect(
      storedCfcEnvelopeMergeIssue(
        storedSchema,
        candidate,
        releaseMergeOptions(tx, target, storedSchema, ["home-module"]),
      )?.message,
    ).toContain("writeAuthorizedBy must remain stable at /name");
  });

  it("refuses a writer of the stamp's module that is not the export it names", async () => {
    const runtime = await start("other-export");
    const tx = runtime.edit();
    trust(tx);
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: PROFILE_MODULE,
      sourceFile: RELEASE_FILE,
      bindingPath: ["unrelated"],
    });
    writeOtherUnder(
      runtime,
      tx,
      "other-export",
      claim(RELEASE_FILE, PROFILE_MODULE),
    );
    expect(refusalOf(await tx.commit())).toContain(
      "writeAuthorizedBy must remain stable at /name",
    );
    expect(storedNameClaim(runtime, "other-export")).toEqual(
      claim(AGED_FILE),
    );
  });

  it("adopts a stamp brought by the writer it names", async () => {
    const runtime = await start("own-stamp");
    const tx = runtime.edit();
    trust(tx);
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: PROFILE_MODULE,
      sourceFile: RELEASE_FILE,
      bindingPath: ["setName"],
    });
    writeOtherUnder(
      runtime,
      tx,
      "own-stamp",
      claim(RELEASE_FILE, PROFILE_MODULE),
    );
    expect((await tx.commit()).error).toBeUndefined();
    expect(storedNameClaim(runtime, "own-stamp")).toEqual(
      claim(RELEASE_FILE, PROFILE_MODULE),
    );
  });
});
