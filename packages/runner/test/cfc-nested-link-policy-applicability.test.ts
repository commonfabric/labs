import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

const ADMIT_MODULE = "nested-link-admit-module";
const ADMIT_FILE = "/patterns/admission.tsx";

const signer = await Identity.fromPassphrase(
  "cfc-nested-link-policy-applicability",
);
const homeSpace = (await Identity.fromPassphrase(
  "cfc-nested-link-policy-applicability home",
)).did() as MemorySpace;

/** The one module the field's claim names. */
const asAdmitter: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: ADMIT_MODULE,
  sourceFile: ADMIT_FILE,
  bindingPath: ["admitPanel"],
};

/** Another verified module, which the claim does not name. */
const asForger: ImplementationIdentity = {
  kind: "verified",
  moduleIdentity: "nested-link-forger-module",
  sourceFile: "/patterns/forger.tsx",
  bindingPath: ["admitPanel"],
};

/**
 * A panel whose `addedByProfile` holds a handle to a profile, which only the
 * admitting module may write: the shape Loom's `PanelAdderProfile` declares,
 * without the principal claims.
 */
const panelSchema: JSONSchema = {
  type: "object",
  properties: {
    addedByProfile: {
      type: "object",
      properties: { name: { type: "string" }, avatar: { type: "string" } },
      asCell: ["cell"],
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            moduleIdentity: ADMIT_MODULE,
            file: ADMIT_FILE,
            path: ["admitPanel"],
          },
        },
      },
    },
  },
};

/** The same panel as a module that declares no claim on it describes it. */
const claimlessPanelSchema: JSONSchema = {
  type: "object",
  properties: {
    addedByProfile: {
      type: "object",
      properties: { name: { type: "string" }, avatar: { type: "string" } },
      asCell: ["cell"],
    },
  },
};

/** A profile document labeled with integrity only, as a Fabric profile is. */
const profileSchema: JSONSchema = {
  type: "object",
  properties: { name: { type: "string" }, avatar: { type: "string" } },
  ifc: { addIntegrity: ["nested-link-test-profile"] },
};

describe("cfc-nested-link-policy-applicability", () => {
  // A pattern result holds each field as a redirect link to the cell that
  // stores it, so a profile a person's home deploys reads `{ name: <link> }`
  // where a plain document reads `{ name: "Ada" }`. The field's write claim
  // applies to a handle to either: the policy's condition does not read a
  // link below the handle as a value that fails `type: "string"`.

  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    storageManager = undefined;
    runtime = undefined;
  });

  const open = (): Runtime => {
    storageManager = StorageManager.emulate({ as: signer });
    return runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "cfc-nested-link-policy-applicability",
        actingPrincipal: signer.did(),
      }),
    });
  };

  /** A profile whose fields are plain values. */
  const plainProfile = async (
    rt: Runtime,
    space: MemorySpace,
    id = "plain-profile",
  ): Promise<Cell<unknown>> => {
    const tx = rt.edit();
    const profile = rt.getCell(space, id, profileSchema, tx);
    profile.set({ name: "Ada", avatar: "ada.png" });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
    return profile;
  };

  /**
   * A profile whose fields are redirect links to the cells that store them,
   * as a pattern result's are.
   */
  const resultProfile = async (
    rt: Runtime,
    space: MemorySpace,
    id = "result-profile",
  ): Promise<Cell<unknown>> => {
    const tx = rt.edit();
    const name = rt.getCell(space, `${id}-name`, undefined, tx);
    name.set("Ada");
    const avatar = rt.getCell(space, `${id}-avatar`, undefined, tx);
    avatar.set("ada.png");
    const profile = rt.getCell(space, id, profileSchema, tx);
    profile.setRaw({
      name: name.getAsWriteRedirectLink(),
      avatar: avatar.getAsWriteRedirectLink(),
    });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
    return profile;
  };

  /**
   * Writes `profile` into a panel's `addedByProfile` as `identity`, through
   * `schema`: the claim-bearing panel schema unless given, and no schema at
   * all for `"none"`, so that the write records no schema input of its own.
   */
  const writeProfile = async (
    rt: Runtime,
    identity: ImplementationIdentity,
    panelId: string,
    profile: Cell<unknown>,
    schema: JSONSchema | "none" = panelSchema,
  ): Promise<string | undefined> => {
    const tx = rt.edit();
    setCfcImplementationIdentity(tx, identity);
    if (schema === "none") {
      rt.getCell(signer.did(), panelId, undefined, tx).key("addedByProfile")
        .set(profile.withTx(tx));
    } else {
      rt.getCell(signer.did(), panelId, schema, tx).set({
        addedByProfile: profile.withTx(tx),
      });
    }
    tx.prepareCfc();
    const error = (await tx.commit()).error?.message;
    await rt.idle();
    return error;
  };

  for (
    const [label, space] of [
      ["in the panel's space", signer.did() as MemorySpace],
      ["in another space", homeSpace],
    ] as const
  ) {
    for (
      const [kind, make] of [
        ["plain", plainProfile],
        ["pattern-result", resultProfile],
      ] as const
    ) {
      it(`refuses a ${kind} profile ${label} written by a module the claim does not name`, async () => {
        const rt = open();
        const profile = await make(rt, space);
        expect(await writeProfile(rt, asForger, `forged-${kind}`, profile))
          .toMatch(/writeAuthorizedBy failed at \/addedByProfile/);
      });

      it(`refuses a ${kind} profile ${label} written over a stored claim by a module whose schema declares none`, async () => {
        // The claim is stored by the admitting module's first write, and the
        // forger's own schema declares none. The write's schema input still
        // carries the stored claim, merged in before verification, so this
        // case holds with or without the link-write overlay; the case below,
        // which records no schema input, is the one that depends on it.
        const rt = open();
        const profile = await make(rt, space);
        expect(await writeProfile(rt, asAdmitter, `stored-${kind}`, profile))
          .toBeUndefined();
        const replacement = await make(rt, space, `replacement-${kind}`);
        expect(
          await writeProfile(
            rt,
            asForger,
            `stored-${kind}`,
            replacement,
            claimlessPanelSchema,
          ),
        ).toMatch(/writeAuthorizedBy failed at \/addedByProfile/);
      });

      it(`refuses a ${kind} profile ${label} written over a stored claim through a cell with no schema`, async () => {
        // The write records no schema input, so the one claim that gates it
        // is the stored one the link write's target path carries.
        const rt = open();
        const profile = await make(rt, space);
        expect(await writeProfile(rt, asAdmitter, `bare-${kind}`, profile))
          .toBeUndefined();
        const replacement = await make(rt, space, `bare-replacement-${kind}`);
        expect(
          await writeProfile(rt, asForger, `bare-${kind}`, replacement, "none"),
        ).toMatch(/writeAuthorizedBy failed at \/addedByProfile/);
      });

      it(`commits a ${kind} profile ${label} written by the module the claim names`, async () => {
        const rt = open();
        const profile = await make(rt, space);
        expect(await writeProfile(rt, asAdmitter, `admitted-${kind}`, profile))
          .toBeUndefined();
      });
    }
  }
});
