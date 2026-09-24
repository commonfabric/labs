import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type JSONSchema,
  type MemorySpace,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  cfcLabelViewForCell,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("loom-root-contract");
const foreignSigner = await Identity.fromPassphrase("loom-root-foreign");
const profileOwner = await Identity.fromPassphrase("loom-root-profile-owner");
const rootSchema = {
  type: "object",
  required: [
    "panels",
    "pieceRegistry",
    "addPiece",
    "duplicatePanel",
    "removePiece",
  ],
  properties: {
    panels: { type: "array", items: { type: "unknown", asCell: ["cell"] } },
    pieceRegistry: pieceListSchema,
    addPiece: { asCell: ["stream"] },
    duplicatePanel: { asCell: ["stream"] },
    removePiece: { asCell: ["stream"] },
  },
} as const;

// A document labeled the way a Fabric profile is: integrity, no
// confidentiality.
const profileSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  ifc: { addIntegrity: ["loom-root-test-profile"] },
} as const;

// The way profile-home stores its owner-protected fields: each carries its
// owner's `represents-principal`, written by the owner through the trusted
// profile editor.
const PROFILE_WRITER = "system.profile-home";
const ownerRepresentation = (owner: string) => ({
  kind: "represents-principal",
  subject: owner,
});
const ownerProtected = <T extends Record<string, unknown>>(
  schema: T,
  owner: string,
) => ({
  ...schema,
  ifc: {
    ownerPrincipal: owner,
    addIntegrity: [ownerRepresentation(owner)],
    writeAuthorizedBy: [PROFILE_WRITER],
    uiContract: {
      helper: "UiAction",
      action: "EditProfile",
      trustedPattern: "ProfileHome",
      requiredEventIntegrity: ["ProfileHome"],
    },
  },
});

/**
 * Writes a profile owned by `owner` and returns it. With `atRoot`, the whole
 * document carries the owner's `represents-principal`; otherwise only its
 * `name` does, as a Fabric profile's fields do.
 */
const writeOwnedProfile = async (
  runtime: Runtime,
  space: MemorySpace,
  id: string,
  owner: string,
  atRoot: boolean,
): Promise<Cell<unknown>> => {
  const schema = atRoot
    ? ownerProtected({
      type: "object",
      properties: { name: { type: "string" } },
    }, owner)
    : {
      type: "object",
      properties: { name: ownerProtected({ type: "string" }, owner) },
    };
  const tx = runtime.edit();
  tx.setCfcTrustSnapshot({ id: `trust-${owner}`, actingPrincipal: owner });
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: PROFILE_WRITER,
  });
  const profile = runtime.getCell(space, id, schema as JSONSchema, tx);
  profile.set({ name: "Owner" });
  const target = profile.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path: atRoot ? [] : ["name"],
    },
    eventId: `edit-${id}`,
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
  tx.prepareCfc();
  const result = await tx.commit();
  if (result.error) throw result.error;
  return profile;
};

describe("loom-root", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let root: Cell<unknown>;

  beforeEach(async () => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: manager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "loom-root-test",
    });
    pieces = new PiecesController(session, runtime);
    await pieces.ready;
    const program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      {
        root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        main: fromFileUrl(
          new URL("../../patterns/loom/main.tsx", import.meta.url),
        ),
        testPaths: [
          "main.test.tsx",
          "presentation-refusals.test.tsx",
          "multi-user.test.tsx",
          "url-view.test.tsx",
        ].map((name) =>
          fromFileUrl(new URL(`../../patterns/loom/${name}`, import.meta.url))
        ),
      },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: pieces.getSpace(),
    });
    root = await pieces.runPersistent(compiled, {}, "loom-root");
    await pieces.linkDefaultPattern(root);
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  it("retains equal document IDs in different spaces and preserves a foreign scope through duplication", async () => {
    const local = runtime.getCell(pieces.getSpace(), { same: "document" });
    const foreign = runtime.getCell(
      foreignSigner.did() as MemorySpace,
      { same: "document" },
      undefined,
      undefined,
      "user",
    );
    expect(local.getAsNormalizedFullLink().id).toBe(
      foreign.getAsNormalizedFullLink().id,
    );
    await pieces.add([local, foreign]);
    const controllers = await pieces.getRegisteredPieces();
    expect(controllers[1].pieces().getSpace()).toBe(foreignSigner.did());
    const registry = await pieces.getPieceRegistry();
    const registered = await registry.pull();
    expect(registered.length).toBe(2);
    expect(registered[0].resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject(local.getAsNormalizedFullLink());
    expect(registered[1].resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject(foreign.getAsNormalizedFullLink());
    const output = root.asSchema(rootSchema);
    const panels = await output.key("panels").pull();
    const duplicate = await output.key("duplicatePanel").pull();
    await new Promise<void>((resolve, reject) =>
      duplicate.send({ panel: panels[1] }, (tx) => {
        const status = tx.status();
        if (status.status === "error") reject(status.error);
        else resolve();
      }, { eventId: "duplicate-foreign", session: signer.did() })
    );
    await runtime.idle();
    const replay = await new Promise<unknown>((resolve) =>
      duplicate.send({ panel: panels[1] }, (tx) => {
        resolve(tx.status());
      }, { eventId: "duplicate-foreign", session: signer.did() })
    );
    expect(replay).toMatchObject({
      status: "error",
      error: {
        name: "PreconditionFailedError",
        precondition: "receipt-exists",
      },
    });
    await runtime.idle();
    const duplicated = await registry.pull();
    expect(duplicated.length).toBe(3);
    expect(duplicated[2].resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject(foreign.getAsNormalizedFullLink());
    expect(
      (await output.key("panels").pull())[1].equals(
        (await output.key("panels").pull())[2],
      ),
    ).toBe(false);
    await pieces.remove(foreign);
    const remaining = await registry.pull();
    expect(remaining.length).toBe(1);
    expect(remaining[0].equals(local)).toBe(true);
  });

  it("labels a panel's adder profile with the principal who added it", async () => {
    const tx = runtime.edit();
    const profile = runtime.getCell(
      pieces.getSpace(),
      "loom-root-adder-profile",
      profileSchema,
      tx,
    );
    profile.set({ name: "Adder" });
    await tx.commit();
    const target = runtime.getCell(pieces.getSpace(), "loom-root-adder-target");
    const output = root.asSchema(rootSchema);
    const addPiece = await output.key("addPiece").pull();
    await new Promise<void>((resolve, reject) =>
      addPiece.send({ piece: target, as: profile }, (tx) => {
        const status = tx.status();
        if (status.status === "error") reject(status.error);
        else resolve();
      }, { eventId: "add-as-profile", session: signer.did() })
    );
    await runtime.idle();
    const panels = await output.key("panels").pull();
    const panel = panels[0].resolveAsCell().getAsNormalizedFullLink();
    const read = runtime.edit();
    const stored = read.readOrThrow({
      space: panel.space,
      scope: panel.scope,
      id: panel.id,
      path: [],
    }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
    read.abort();
    expect(stored.cfc?.labelMap?.entries).toContainEqual(
      expect.objectContaining({
        path: ["addedByProfile"],
        label: expect.objectContaining({
          integrity: expect.arrayContaining([{
            kind: "represents-principal",
            subject: signer.did(),
          }]),
        }),
      }),
    );
  });

  for (const atRoot of [false, true]) {
    it(
      `keeps the actor apart from the linked profile's owner when the profile is labeled ${
        atRoot ? "at its root" : "on its fields"
      }`,
      async () => {
        const owned = await writeOwnedProfile(
          runtime,
          pieces.getSpace(),
          `loom-root-owned-profile-${atRoot}`,
          profileOwner.did(),
          atRoot,
        );
        const target = runtime.getCell(
          pieces.getSpace(),
          `loom-root-owned-target-${atRoot}`,
        );
        const output = root.asSchema(rootSchema);
        const addPiece = await output.key("addPiece").pull();
        await new Promise<void>((resolve, reject) =>
          addPiece.send({ piece: target, as: owned }, (tx) => {
            const status = tx.status();
            if (status.status === "error") reject(status.error);
            else resolve();
          }, { eventId: `add-owned-${atRoot}`, session: signer.did() })
        );
        await runtime.idle();
        const panels = await output.key("panels").pull();
        const panel = panels[0].resolveAsCell();
        const link = panel.getAsNormalizedFullLink();
        const read = runtime.edit();
        const metadata = readStoredCfcMetadata(read, link);
        read.abort();
        const representations = (
          entry: { label: { integrity?: readonly unknown[] } },
        ) =>
          (entry.label.integrity ?? []).filter((atom) =>
            (atom as { kind?: unknown }).kind === "represents-principal"
          );
        const entries = metadata?.labelMap.entries ?? [];
        const declared = entries.filter((entry) =>
          entry.origin !== "link" &&
          entry.path.length === 1 && entry.path[0] === "addedByProfile"
        );
        const copied = entries.filter((entry) =>
          entry.origin === "link" && entry.path[0] === "addedByProfile"
        );
        // The actor is the one declared entry at exactly the field.
        expect(declared.flatMap(representations)).toEqual([
          ownerRepresentation(signer.did()),
        ]);
        // The linked profile's owner arrives only as a copy of its label.
        expect(copied.flatMap(representations)).toEqual([
          ownerRepresentation(profileOwner.did()),
        ]);
        // A merged label view does not say which is which.
        const merged = cfcLabelViewForCell(panel.key("addedByProfile"))
          ?.entries.flatMap(representations) ?? [];
        expect(merged).toEqual(
          expect.arrayContaining([
            ownerRepresentation(signer.did()),
            ownerRepresentation(profileOwner.did()),
          ]),
        );
      },
    );
  }
});
