import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { cfcLabelViewForCell } from "../src/cfc/mod.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase(
  "profile-home-verified-identities",
);
const space = signer.did();
const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const PROGRAM: RuntimeProgram = {
  main: "/profile-home.tsx",
  files: [{
    name: "/profile-home.tsx",
    contents: Deno.readTextFileSync(sysDir + "profile-home.tsx"),
  }],
};
const INTEGRITY = CFC_LOOM_VERIFIED_EXTERNAL_IDENTITY_ATOM;

const assertionSchema = (addIntegrity: boolean): JSONSchema => ({
  type: "object",
  properties: {
    type: {
      type: "string",
      ...(addIntegrity ? { ifc: { addIntegrity: [INTEGRITY] } } : {}),
    },
    value: {
      type: "string",
      ...(addIntegrity ? { ifc: { addIntegrity: [INTEGRITY] } } : {}),
    },
    verifiedAt: {
      type: "string",
      ...(addIntegrity ? { ifc: { addIntegrity: [INTEGRITY] } } : {}),
    },
  },
  required: ["type", "value", "verifiedAt"],
  ...(addIntegrity ? { ifc: { addIntegrity: [INTEGRITY] } } : {}),
});

function integrityAtoms(cell: unknown): unknown[] {
  return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap(
    (entry) => entry.label.integrity ?? [],
  );
}

describe("profile-home verified external identities", () => {
  let manager: EmulatedStorageManager;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await manager?.close();
  });

  it("collects and revokes the original integrity-bearing assertion cell", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
        tx,
      });
      const resultCell = runtime.getCell<Record<string, unknown>>(
        space,
        "profile-home verified identity",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const result = runtime.run(tx, pattern as any, {
        initialName: "Ada Lovelace",
      }, resultCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();

      // Loom's verifier writes the assertion as a builtin, the only author
      // the runtime lets mint the verified-identity atom.
      const assertionTx = runtime.edit();
      assertionTx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "loom-verified-identity-publisher",
      });
      const assertion = runtime.getCell(
        space,
        "loom verified github login",
        assertionSchema(true),
        assertionTx,
      );
      assertion.set({
        type: "github.login",
        value: "ada",
        verifiedAt: "2026-07-15T20:00:00.000Z",
      });
      runtime.prepareTxForCommit(assertionTx);
      expect((await assertionTx.commit()).error).toBeUndefined();

      const publishTx = runtime.edit();
      result.withTx(publishTx).key("publishVerifiedIdentities").send({
        identities: [assertion.withTx(publishTx)],
      });
      runtime.prepareTxForCommit(publishTx);
      expect((await publishTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();

      const item = result.key("verifiedIdentities").key(0);
      expect(await item.pull()).toEqual({
        type: "github.login",
        value: "ada",
        verifiedAt: "2026-07-15T20:00:00.000Z",
      });
      const linkedItems = result.key("verifiedIdentities").asSchema({
        type: "array",
        items: {
          ...(assertionSchema(false) as unknown as Record<string, unknown>),
          asCell: ["cell"],
        },
      }).get();
      expect(linkedItems).toHaveLength(1);
      expect(linkedItems[0].equalLinks(assertion)).toBe(true);
      for (const field of ["type", "value", "verifiedAt"]) {
        expect(integrityAtoms(linkedItems[0].key(field))).toContain(INTEGRITY);
      }

      const revokeTx = runtime.edit();
      result.withTx(revokeTx).key("revokeVerifiedIdentities").send({
        identities: [assertion.withTx(revokeTx)],
      });
      // The send's resolution crosses the result doc's ifc-bearing link, which
      // marks the transaction cfc-relevant, and a relevant transaction must be
      // prepared before commit — same as the publish above.
      runtime.prepareTxForCommit(revokeTx);
      expect((await revokeTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      expect(result.key("verifiedIdentities").get()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses an assertion that a writer other than the verifier labeled", async () => {
    // The self-assertion case: any writer in the principal's home space can
    // name the verified-identity atom in its write schema. Only a write the
    // runtime attributes to a builtin may mint it, so this label is dropped
    // at persist time and the assertion fails the profile's integrity floor.
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const setupTx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
        tx: setupTx,
      });
      const result = runtime.run(
        setupTx,
        // deno-lint-ignore no-explicit-any
        pattern as any,
        { initialName: "Ada Lovelace" },
        runtime.getCell(
          space,
          "profile-home refuses self-asserted identity",
          undefined,
          setupTx,
        ),
      );
      runtime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit()).error).toBeUndefined();
      await result.pull();

      const assertionTx = runtime.edit();
      const assertion = runtime.getCell(
        space,
        "self-asserted github login",
        assertionSchema(true),
        assertionTx,
      );
      assertion.set({
        type: "github.login",
        value: "mallory",
        verifiedAt: "2026-07-15T20:00:00.000Z",
      });
      runtime.prepareTxForCommit(assertionTx);
      expect((await assertionTx.commit()).error).toBeUndefined();
      for (const field of ["type", "value", "verifiedAt"]) {
        expect(integrityAtoms(assertion.key(field))).not.toContain(INTEGRITY);
      }

      const publishTx = runtime.edit();
      result.withTx(publishTx).key("publishVerifiedIdentities").send({
        identities: [assertion.withTx(publishTx)],
      });
      runtime.prepareTxForCommit(publishTx);
      expect((await publishTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      expect(result.key("verifiedIdentities").get()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects an unlabeled assertion before the publish handler runs", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const setupTx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
        tx: setupTx,
      });
      const result = runtime.run(
        setupTx,
        // deno-lint-ignore no-explicit-any
        pattern as any,
        { initialName: "Ada Lovelace" },
        runtime.getCell(
          space,
          "profile-home rejects unlabeled identity",
          undefined,
          setupTx,
        ),
      );
      runtime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit()).error).toBeUndefined();
      await result.pull();

      const assertionTx = runtime.edit();
      const assertion = runtime.getCell(
        space,
        "unlabeled github login",
        assertionSchema(false),
        assertionTx,
      );
      assertion.set({
        type: "github.login",
        value: "mallory",
        verifiedAt: "2026-07-15T20:00:00.000Z",
      });
      runtime.prepareTxForCommit(assertionTx);
      expect((await assertionTx.commit()).error).toBeUndefined();

      const publishTx = runtime.edit();
      result.withTx(publishTx).key("publishVerifiedIdentities").send({
        identities: [assertion.withTx(publishTx)],
      });
      runtime.prepareTxForCommit(publishTx);
      expect((await publishTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      expect(result.key("verifiedIdentities").get()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
