import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type JSONSchema,
  type MemorySpace,
  Runtime,
  sendEvent,
  type Stream,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  cfcLabelViewForCell,
  readStoredCfcMetadata,
} from "@commonfabric/runner/cfc";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "@commonfabric/runner/cfc/trust-authority";

const signer = await Identity.fromPassphrase("loom-root-contract");
const foreignSigner = await Identity.fromPassphrase("loom-root-foreign");
const profileOwner = await Identity.fromPassphrase("loom-root-profile-owner");
const thirdOwner = await Identity.fromPassphrase("loom-root-third-owner");
const homeSpace = (await Identity.fromPassphrase("loom-root-home-space"))
  .did() as MemorySpace;
const rootSchema = {
  type: "object",
  required: [
    "panels",
    "pieceRegistry",
    "addPiece",
    "duplicatePanel",
    "removePiece",
    "removePanel",
    "movePanel",
    "setPresentation",
    "presentation",
  ],
  properties: {
    panels: { type: "array", items: { type: "unknown", asCell: ["cell"] } },
    pieceRegistry: pieceListSchema,
    addPiece: { asCell: ["stream"] },
    duplicatePanel: { asCell: ["stream"] },
    removePiece: { asCell: ["stream"] },
    removePanel: { asCell: ["stream"] },
    movePanel: { asCell: ["stream"] },
    setPresentation: { asCell: ["stream"] },
    presentation: {
      type: "object",
      properties: {
        stagedPanels: {
          type: "array",
          items: { type: "unknown", asCell: ["cell"] },
        },
      },
    },
  },
} as const;

// The streams that retitle a Loom and retitle or retarget one of its panels.
const editSchema = {
  type: "object",
  required: [
    "title",
    "panels",
    "addPiece",
    "retitleLoom",
    "retitlePanel",
    "retargetPanel",
  ],
  properties: {
    title: { type: "string" },
    panels: { type: "array", items: { type: "unknown", asCell: ["cell"] } },
    addPiece: { asCell: ["stream"] },
    retitleLoom: { asCell: ["stream"] },
    retitlePanel: { asCell: ["stream"] },
    retargetPanel: { asCell: ["stream"] },
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
  setCfcTrustSnapshot(tx, { id: `trust-${owner}`, actingPrincipal: owner });
  setCfcImplementationIdentity(tx, {
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
  const result = await tx.commit().settled;
  if (result.error) throw result.error;
  return profile;
};

/**
 * Writes a string cell owned by `owner` through the trusted profile editor,
 * as profile-home stores each owner-protected field in a cell of its own.
 */
const writeOwnedString = async (
  runtime: Runtime,
  space: MemorySpace,
  id: string,
  owner: string,
): Promise<Cell<unknown>> => {
  const tx = runtime.edit();
  setCfcTrustSnapshot(tx, { id: `trust-${owner}`, actingPrincipal: owner });
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: PROFILE_WRITER,
  });
  const cell = runtime.getCell(
    space,
    id,
    ownerProtected({ type: "string" }, owner) as JSONSchema,
    tx,
  );
  cell.set("Owner");
  const target = cell.getAsNormalizedFullLink();
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path: [],
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
  const result = await tx.commit().settled;
  if (result.error) throw result.error;
  return cell;
};

type LabelEntry = {
  path: readonly (string | number)[];
  origin?: string;
  label: { integrity?: readonly unknown[] };
};

/** The subjects of `kind` claims among `entries`' integrity atoms. */
const claimSubjects = (
  entries: readonly LabelEntry[],
  kind: "authored-by" | "represents-principal",
): string[] =>
  entries.flatMap((entry) =>
    (entry.label.integrity ?? []).flatMap((atom) => {
      const claim = atom as { kind?: unknown; subject?: unknown };
      return claim.kind === kind && typeof claim.subject === "string"
        ? [claim.subject]
        : [];
    })
  );

/** The `represents-principal` subjects among `entries`' integrity atoms. */
const representedSubjects = (entries: readonly LabelEntry[]): string[] =>
  claimSubjects(entries, "represents-principal");

/** Sends `event` to `stream` and waits for its transaction to settle. */
const sendAndSettle = (
  stream: Readonly<Stream<unknown>>,
  event: unknown,
  eventId: string,
): Promise<void> =>
  new Promise<void>((resolve, reject) =>
    sendEvent(stream, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") reject(status.error);
      else resolve();
    }, { eventId, session: signer.did() })
  );

/**
 * Sends `event` to `stream` under `eventId`, and returns the status its
 * transaction ended with, refused or not.
 */
const sendAgain = (
  stream: Readonly<Stream<unknown>>,
  event: unknown,
  eventId: string,
): Promise<unknown> =>
  new Promise<unknown>((resolve) =>
    sendEvent(
      stream,
      event,
      (tx) => resolve(tx.status()),
      { eventId, session: signer.did() },
    )
  );

/** How a repeat of an invocation the root already handled ends. */
const receiptExists = {
  status: "error",
  error: { name: "PreconditionFailedError", precondition: "receipt-exists" },
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
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
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
      sendEvent(duplicate, { panel: panels[1] }, (tx) => {
        const status = tx.status();
        if (status.status === "error") reject(status.error);
        else resolve();
      }, { eventId: "duplicate-foreign", session: signer.did() })
    );
    await runtime.idle();
    const replay = await new Promise<unknown>((resolve) =>
      sendEvent(duplicate, { panel: panels[1] }, (tx) => {
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
    await tx.commit().settled;
    const target = runtime.getCell(pieces.getSpace(), "loom-root-adder-target");
    const output = root.asSchema(rootSchema);
    const addPiece = await output.key("addPiece").pull();
    await new Promise<void>((resolve, reject) =>
      sendEvent(addPiece, { piece: target, as: profile }, (tx) => {
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

  it("links an occurrence whose `addedBy` label names the caller alone or nobody, and refuses one it contests or names in a form no runtime mints", async () => {
    /** Stores a URL occurrence at `cause` whose label map is `entries`. */
    const occurrence = async (cause: string, entries: unknown[]) => {
      const cell = runtime.getCell(pieces.getSpace(), cause);
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, pieces.getSpace());
      seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
        value: {
          kind: "url",
          url: `https://example.com/${cause}`,
          addedBy: signer.did(),
        },
        ...(entries.length === 0 ? {} : {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries },
          },
        }),
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell;
    };
    /** A declared entry at `path` whose integrity is `atoms`. */
    const at = (path: string[], ...atoms: unknown[]) => ({
      path,
      label: { integrity: atoms },
      origin: "declared",
    });
    const by = (subject: string) => ({ kind: "authored-by", subject });
    const output = root.asSchema(rootSchema);
    const addPanel = await output.key("addPanel").pull();
    const refused = [
      await occurrence("contested", [
        at(["addedBy"], by(signer.did()), by(foreignSigner.did())),
      ]),
      await occurrence("misspelled", [
        at(["addedBy"], `authored-by:${signer.did()}`),
      ]),
      await occurrence("root-contested", [
        at([], by(foreignSigner.did())),
        at(["addedBy"], by(signer.did())),
      ]),
    ];
    // A refused event aborts its transaction; the handler's own error
    // reaches the scheduler's error handlers.
    const errors: string[] = [];
    runtime.scheduler.onError((error) => errors.push(String(error)));
    for (const [index, panel] of refused.entries()) {
      errors.length = 0;
      const refusal = await sendAndSettle(
        addPanel,
        { panel },
        `refused-${index}`,
      ).then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeDefined();
      expect(
        errors.some((error) =>
          error.includes("whose adder its label contests")
        ),
      ).toBe(true);
    }
    expect((await output.key("panels").pull()).length).toBe(0);
    const linked = [
      await occurrence("own", [at(["addedBy"], by(signer.did()))]),
      await occurrence("claimed", []),
    ];
    for (const [index, panel] of linked.entries()) {
      await sendAndSettle(addPanel, { panel }, `linked-${index}`);
    }
    await runtime.idle();
    const panels = await output.key("panels").pull();
    expect(panels.length).toBe(2);
    expect(
      panels.map((panel, index) => panel.resolveAsCell().equals(linked[index])),
    ).toEqual([true, true]);
  });

  it("records the registering principal as a panel's adder, with an `authored-by` entry declared at the field", async () => {
    const target = runtime.getCell(
      pieces.getSpace(),
      "loom-root-registered-target",
    );
    await pieces.add([target]);
    const panels = await root.asSchema(rootSchema).key("panels").pull();
    expect(panels.length).toBe(1);
    const panel = panels[0].resolveAsCell();
    const value = await panel.asSchema({
      type: "object",
      properties: { addedBy: { type: "string" } },
    }).pull();
    expect(value.addedBy).toBe(signer.did());
    const read = runtime.edit();
    const entries = (readStoredCfcMetadata(
      read,
      panel.getAsNormalizedFullLink(),
    )?.labelMap.entries ?? []) as readonly LabelEntry[];
    read.abort();
    expect(
      claimSubjects(
        entries.filter((entry) =>
          entry.origin !== "link" &&
          entry.path.length === 1 && entry.path[0] === "addedBy"
        ),
        "authored-by",
      ),
    ).toEqual([signer.did()]);
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
          sendEvent(addPiece, { piece: target, as: owned }, (tx) => {
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

  /**
   * Deploys the real profile-home pattern, as `own_profile` names a person's
   * Fabric profile: its result document holds each field as a redirect link
   * to the cell that stores it. With `space`, it is deployed there, as a
   * person's profile lives in their own home space.
   */
  const deployProfileHome = async (
    cause: string,
    space: MemorySpace = pieces.getSpace(),
  ): Promise<Cell<unknown>> => {
    const program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      {
        root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        main: fromFileUrl(
          new URL("../../patterns/system/profile-home.tsx", import.meta.url),
        ),
      },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const home = space === pieces.getSpace()
      ? await pieces.runPersistent(compiled, { initialName: "Home" }, cause)
      : await runtime.runSynced(
        runtime.getCell(space, cause),
        compiled,
        { initialName: "Home" },
      );
    await runtime.idle();
    return home;
  };

  /** A plain document labeled with integrity only. */
  const writePlainProfile = async (id: string): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const profile = runtime.getCell(pieces.getSpace(), id, profileSchema, tx);
    profile.set({ name: "Plain" });
    const result = await tx.commit().settled;
    if (result.error) throw result.error;
    return profile;
  };

  /** The subjects the panel's declared entry at exactly the field names. */
  const declaredAdders = (panel: Cell<unknown>): string[] => {
    const read = runtime.edit();
    const entries = (readStoredCfcMetadata(
      read,
      panel.getAsNormalizedFullLink(),
    )?.labelMap.entries ?? []) as readonly LabelEntry[];
    read.abort();
    return representedSubjects(
      entries.filter((entry) =>
        entry.origin !== "link" &&
        entry.path.length === 1 && entry.path[0] === "addedByProfile"
      ),
    );
  };

  it("labels the adder whether `as` names a plain document or a profile-home profile, in the Loom's space or another", async () => {
    const plain = await writePlainProfile("loom-root-plain-control");
    const home = await deployProfileHome("loom-root-profile-home");
    const elsewhere = await deployProfileHome(
      "loom-root-profile-home-elsewhere",
      homeSpace,
    );
    const profiles = [plain, home, elsewhere];
    const output = root.asSchema(rootSchema);
    const addPiece = await output.key("addPiece").pull();
    for (const [index, profile] of profiles.entries()) {
      await sendAndSettle(
        addPiece,
        {
          piece: runtime.getCell(
            pieces.getSpace(),
            `loom-root-as-target-${index}`,
          ),
          as: profile,
        },
        `add-as-${index}`,
      );
      await runtime.idle();
    }
    const panels = (await output.key("panels").pull()).map((panel) =>
      panel.resolveAsCell()
    );
    expect(panels.length).toBe(profiles.length);
    // Each panel links the profile it was added under, and its declared
    // entry names whoever acted: the plain control, the profile-home profile
    // in the Loom's space, and the one in another space, each on its own.
    expect(
      panels.map((panel, index) =>
        panel.key("addedByProfile").resolveAsCell().equals(profiles[index])
      ),
    ).toEqual([true, true, true]);
    expect(panels.map(declaredAdders)).toEqual([
      [signer.did()],
      [signer.did()],
      [signer.did()],
    ]);
  });

  it("removes an occurrence for the principal its label attests as its adder, for anyone when it attests nobody, and for an OWNER when the adder has left", async () => {
    const space = pieces.getSpace();
    const output = root.asSchema(rootSchema);
    const addPanel = await output.key("addPanel").pull();
    const removePanel = await output.key("removePanel").pull();
    const removePiece = await output.key("removePiece").pull();
    /** A declared entry at `path` whose integrity is `atoms`. */
    const at = (path: string[], ...atoms: unknown[]) => ({
      path,
      label: { integrity: atoms },
      origin: "declared",
    });
    const by = (subject: string) => ({ kind: "authored-by", subject });
    const represents = (subject: string) => ({
      kind: "represents-principal",
      subject,
    });
    const envelope = (entries: unknown[]) => ({
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    });
    /** Stores `value` at `cause` in `where` with a label map of `entries`. */
    const stored = async (
      cause: string,
      value: unknown,
      entries: unknown[],
      where: MemorySpace = space,
    ) => {
      const cell = runtime.getCell(where, cause);
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, where);
      seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
        value,
        ...(entries.length === 0 ? {} : { cfc: envelope(entries) }),
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell;
    };
    /**
     * Links an occurrence into the root, then stores `value` and a label map
     * of `entries` at it: the link guard admits only an occurrence that names
     * no profile and that no label attests to another principal, so both
     * follow the link.
     */
    const linked = async (
      cause: string,
      value: unknown,
      entries: unknown[],
      where: MemorySpace = space,
    ) => {
      const { addedByProfile: _, ...linkable } = value as Record<
        string,
        unknown
      >;
      const cell = await stored(cause, linkable, [], where);
      await sendAndSettle(addPanel, { panel: cell }, `link-${cause}`);
      const tx = runtime.edit();
      seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
        value,
        ...(entries.length === 0 ? {} : { cfc: envelope(entries) }),
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell;
    };
    const url = (cause: string) => ({
      kind: "url",
      url: `https://example.com/${cause}`,
    });
    const errors: string[] = [];
    runtime.scheduler.onError((error) => errors.push(String(error)));
    /** Sends `event` to `stream` and returns whether it was refused with `message`. */
    const refusedWith = async (
      stream: Readonly<Stream<unknown>>,
      event: unknown,
      eventId: string,
      message: string,
    ) => {
      errors.length = 0;
      const refusal = await sendAndSettle(stream, event, eventId)
        .then(() => undefined, (error: unknown) => error);
      return refusal !== undefined &&
        errors.some((error) => error.includes(message));
    };
    const holds = async (cell: Cell<unknown>) =>
      (await output.key("panels").pull()).some((panel) =>
        panel.resolveAsCell().equals(cell)
      );
    /** Replaces the space's access list, as a member's replica would read it. */
    const setAcl = async (acl: Record<string, string>) => {
      const tx = runtime.edit();
      seedStoredEnvelope(
        tx,
        { space, scope: "space", id: `of:${space}` as never, path: [] },
        { value: acl } as never,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
    };
    // The caller owns the space; the foreign signer is a WRITE member; the
    // profile owner is nobody there.
    await setAcl({ [signer.did()]: "OWNER", [foreignSigner.did()]: "WRITE" });

    // The caller's own profile, linked on an occurrence another principal
    // added under it: the stamp on the field names who acted.
    const ownProfile = await stored("own-profile", { name: "Mine" }, [
      at([], represents(signer.did())),
    ]);
    // A DID stored in its own document, labeled as the caller's writing, for
    // an `addedBy` that links it: the stamp on the field is read, the label
    // on the document the link leads to is not.
    const didCell = await stored("did-cell", signer.did(), [
      at([], by(signer.did())),
    ]);
    const others = "Only the principal who added a panel can remove it";
    const refusals: [string, unknown, unknown[], string][] = [
      // A malformed field names nobody; the well-formed one still does.
      ["malformed-beside-stamp", {
        ...url("malformed-beside-stamp"),
        addedByProfile: ownProfile.getAsLink(),
      }, [
        at(["addedBy"], `authored-by:${signer.did()}`),
        at(["addedByProfile"], represents(foreignSigner.did())),
      ], others],
      ["stamped-other", url("stamped-other"), [
        at(["addedBy"], by(foreignSigner.did())),
      ], others],
      ["under-own-profile", {
        ...url("under-own-profile"),
        addedByProfile: ownProfile.getAsLink(),
      }, [
        at(["addedByProfile"], represents(foreignSigner.did())),
        { ...at(["addedByProfile"], represents(signer.did())), origin: "link" },
      ], others],
      [
        "linked-addedby-other",
        {
          ...url("linked-addedby-other"),
          addedBy: didCell.getAsLink(),
        },
        [at(["addedBy"], by(foreignSigner.did()))],
        others,
      ],
    ];
    for (const [cause, value, entries, message] of refusals) {
      const cell = await linked(cause, value, entries);
      expect([
        cause,
        await refusedWith(removePanel, { panel: cell }, `rm-${cause}`, message),
      ]).toEqual([cause, true]);
      expect([cause, await holds(cell)]).toEqual([cause, true]);
    }

    const removals: [string, unknown, unknown[]][] = [
      ["stamped-own", url("stamped-own"), [at(["addedBy"], by(signer.did()))]],
      ["claimed-other", {
        ...url("claimed-other"),
        addedBy: foreignSigner.did(),
      }, []],
      ["unattributed", url("unattributed"), []],
      ["linked-addedby-own", {
        ...url("linked-addedby-own"),
        addedBy: didCell.getAsLink(),
      }, [at(["addedBy"], by(signer.did()))]],
      // A label that settles on no single adder protects nobody: any writer
      // removes the occurrence.
      ["two-adders", url("two-adders"), [
        at(["addedBy"], by(signer.did()), by(foreignSigner.did())),
      ]],
      ["both-fields", url("both-fields"), [
        at(["addedBy"], by(signer.did())),
        at(["addedByProfile"], represents(foreignSigner.did())),
      ]],
      ["misspelled", url("misspelled"), [
        at(["addedBy"], `authored-by:${signer.did()}`),
      ]],
      // An OWNER removes what a participant who has left added.
      ["stamped-departed", url("stamped-departed"), [
        at(["addedBy"], by(profileOwner.did())),
      ]],
    ];
    for (const [cause, value, entries] of removals) {
      const cell = await linked(cause, value, entries);
      await sendAndSettle(removePanel, { panel: cell }, `rm-${cause}`);
      expect([cause, await holds(cell)]).toEqual([cause, false]);
    }

    // An occurrence the root admitted under another person's profile is its
    // actor's to remove: the profile's owner is not who added it.
    const borrowed = await stored("borrowed-profile", { name: "Theirs" }, [
      at([], represents(profileOwner.did())),
    ]);
    await sendAndSettle(
      await output.key("addPiece").pull(),
      { piece: runtime.getCell(space, "borrowed-target"), as: borrowed },
      "add-as-borrowed",
    );
    await runtime.idle();
    const admitted = (await output.key("panels").pull()).map((panel) =>
      panel.resolveAsCell()
    ).find((panel) =>
      panel.key("addedByProfile").resolveAsCell().equals(borrowed)
    )!;
    expect(declaredAdders(admitted)).toEqual([signer.did()]);
    await sendAndSettle(removePanel, { panel: admitted }, "rm-admitted");
    expect(await holds(admitted)).toBe(false);

    // Unregistering a piece removes every occurrence of it or none.
    const piece = runtime.getCell(space, "shared-target");
    const mine = await linked("piece-mine", {
      kind: "piece",
      piece: piece.getAsLink(),
    }, [at(["addedBy"], by(signer.did()))]);
    const theirs = await linked("piece-theirs", {
      kind: "piece",
      piece: piece.getAsLink(),
    }, [at(["addedBy"], by(foreignSigner.did()))]);
    expect(await refusedWith(removePiece, { piece }, "unregister", others))
      .toBe(true);
    expect([await holds(mine), await holds(theirs)]).toEqual([true, true]);

    // A WRITE member does not clear up after one who has left: only an OWNER.
    const departed = await linked("departed-again", url("departed-again"), [
      at(["addedBy"], by(profileOwner.did())),
    ]);
    await setAcl({
      [thirdOwner.did()]: "OWNER",
      [signer.did()]: "WRITE",
      [foreignSigner.did()]: "WRITE",
    });
    expect(
      await refusedWith(
        removePanel,
        { panel: departed },
        "rm-as-writer",
        others,
      ),
    ).toBe(true);
    expect(await holds(departed)).toBe(true);

    // An occurrence linked from another space is judged by the Loom's list,
    // not that space's: owning the occurrence's space, whose list omits a
    // current member, does not let a WRITE member of the Loom remove that
    // member's panel.
    const mineAlone = await runtime.createSpace();
    const elsewhere = await linked(
      "elsewhere",
      url("elsewhere"),
      [at(["addedBy"], by(foreignSigner.did()))],
      mineAlone,
    );
    expect(
      await refusedWith(
        removePanel,
        { panel: elsewhere },
        "rm-elsewhere",
        others,
      ),
    ).toBe(true);
    expect(await holds(elsewhere)).toBe(true);
    // And one who has left the Loom is cleared up by a Loom OWNER although
    // the occurrence's own space still admits them.
    await setAcl({ [signer.did()]: "OWNER" });
    const theirSpace = await runtime.createSpace({
      grants: { [foreignSigner.did()]: "WRITE" },
    });
    const left = await linked(
      "left-elsewhere",
      url("left-elsewhere"),
      [at(["addedBy"], by(foreignSigner.did()))],
      theirSpace,
    );
    await sendAndSettle(removePanel, { panel: left }, "rm-left-elsewhere");
    expect(await holds(left)).toBe(false);
  });

  it("names the actor, not the owner, when `as` names another person's profile whose fields are redirect links", async () => {
    // Shaped as another person's profile-home result: each field is a
    // redirect link to a cell its owner wrote through the trusted editor, so
    // the cell carries the owner's `represents-principal`.
    const nameCell = await writeOwnedString(
      runtime,
      homeSpace,
      "loom-root-borrowed-name",
      profileOwner.did(),
    );
    const tx = runtime.edit();
    const borrowed = runtime.getCell(
      homeSpace,
      "loom-root-borrowed-profile",
      profileSchema,
      tx,
    );
    (borrowed as Cell<unknown>).setRaw({
      name: nameCell.getAsWriteRedirectLink(),
    });
    const written = await tx.commit().settled;
    if (written.error) throw written.error;

    const output = root.asSchema(rootSchema);
    await sendAndSettle(
      await output.key("addPiece").pull(),
      {
        piece: runtime.getCell(pieces.getSpace(), "loom-root-borrowed-target"),
        as: borrowed,
      },
      "add-as-borrowed",
    );
    await runtime.idle();
    const panel = (await output.key("panels").pull())[0].resolveAsCell();
    expect(panel.key("addedByProfile").resolveAsCell().equals(borrowed))
      .toBe(true);
    expect(declaredAdders(panel)).toEqual([signer.did()]);
  });

  it("keeps each panel's adder and profile owner with that panel when an earlier panel is removed or the list is reordered", async () => {
    // The middle panel is added under no profile, so a label that stayed with
    // a list position instead of its element would show up on it.
    const owners = [profileOwner, undefined, thirdOwner];
    const profiles = await Promise.all(
      owners.map((owner, index) =>
        owner === undefined ? undefined : writeOwnedProfile(
          runtime,
          pieces.getSpace(),
          `loom-root-reorder-profile-${index}`,
          owner.did(),
          false,
        )
      ),
    );
    const output = root.asSchema(rootSchema);
    const addPiece = await output.key("addPiece").pull();
    for (const [index, profile] of profiles.entries()) {
      const piece = runtime.getCell(
        pieces.getSpace(),
        `loom-root-reorder-target-${index}`,
      );
      await sendAndSettle(
        addPiece,
        profile === undefined ? { piece } : { piece, as: profile },
        `add-reorder-${index}`,
      );
      await runtime.idle();
    }

    const panelsNow = async () =>
      (await output.key("panels").pull()).map((panel) => panel.resolveAsCell());
    const [first, second, third] = await panelsNow();
    // Stage all three, so the presentation holds link copies of their labels
    // too. Then remove the first panel, so the others each move up one
    // position in both lists, and move the last one to the front of the
    // panels.
    await sendAndSettle(
      await output.key("setPresentation").pull(),
      { stagedPanels: [first, second, third] },
      "stage-reorder-all",
    );
    await runtime.idle();
    await sendAndSettle(
      await output.key("removePanel").pull(),
      { panel: first },
      "remove-reorder-first",
    );
    await runtime.idle();
    await sendAndSettle(
      await output.key("movePanel").pull(),
      { panel: third, before: second },
      "move-reorder-third",
    );
    await runtime.idle();

    const remaining = await panelsNow();
    expect(remaining.length).toBe(2);
    expect(remaining[0].equals(third)).toBe(true);
    expect(remaining[1].equals(second)).toBe(true);
    const staged = (await output.key("presentation").pull()).stagedPanels ??
      [];
    expect(staged.length).toBe(2);
    expect(staged[0].equals(second)).toBe(true);
    expect(staged[1].equals(third)).toBe(true);

    const read = runtime.edit();
    const storedEntries = (link: { id: string; path: readonly string[] }) =>
      (readStoredCfcMetadata(read, link as never)?.labelMap.entries ??
        []) as readonly LabelEntry[];
    // Each panel's own document: the actor is the one declared entry at
    // exactly the field, and the copied label is its own profile's owner.
    const thirdEntries = storedEntries(third.getAsNormalizedFullLink());
    expect(
      representedSubjects(
        thirdEntries.filter((entry) =>
          entry.origin !== "link" &&
          entry.path.length === 1 && entry.path[0] === "addedByProfile"
        ),
      ),
    ).toEqual([signer.did()]);
    expect(
      representedSubjects(
        thirdEntries.filter((entry) =>
          entry.origin === "link" && entry.path[0] === "addedByProfile"
        ),
      ),
    ).toEqual([thirdOwner.did()]);
    expect(representedSubjects(storedEntries(second.getAsNormalizedFullLink())))
      .toEqual([]);

    // A list holds its elements' labels as link copies, under each element's
    // current position.
    const atPosition = (
      list: { id: string; path: readonly string[] },
      index: number,
    ) =>
      representedSubjects(
        storedEntries(list).filter((entry) =>
          entry.origin === "link" &&
          list.path.every((key, depth) => entry.path[depth] === key) &&
          String(entry.path[list.path.length]) === String(index)
        ),
      );
    const panelsList = output.key("panels").resolveAsCell()
      .getAsNormalizedFullLink();
    expect(atPosition(panelsList, 0).sort()).toEqual(
      [signer.did(), thirdOwner.did()].sort(),
    );
    expect(atPosition(panelsList, 1)).toEqual([]);
    const stagedList = output.key("presentation").key("stagedPanels")
      .resolveAsCell().getAsNormalizedFullLink();
    expect(atPosition(stagedList, 0)).toEqual([]);
    expect(atPosition(stagedList, 1).sort()).toEqual(
      [signer.did(), thirdOwner.did()].sort(),
    );
    read.abort();
  });

  describe("a repeated edit invocation", () => {
    /** Registers a piece and returns the root's view and its one panel. */
    const rootWithPanel = async (id: string) => {
      const output = root.asSchema(editSchema);
      const piece = runtime.getCell(pieces.getSpace(), `loom-root-${id}`);
      await sendAndSettle(
        await output.key("addPiece").pull(),
        { piece },
        `add-${id}`,
      );
      await runtime.idle();
      const [panel] = (await output.key("panels").pull()).map((entry) =>
        entry.resolveAsCell()
      );
      return { output, panel };
    };

    /** What `cell` holds, read in a transaction of its own. */
    const storedValue = (cell: Cell<unknown>): unknown => {
      const read = runtime.edit();
      const value = cell.withTx(read).getRaw();
      read.abort();
      return value;
    };

    it("leaves the title a later `retitleLoom` set", async () => {
      const { output } = await rootWithPanel("retitle-loom");
      const retitle = await output.key("retitleLoom").pull();
      await sendAndSettle(retitle, { title: "First" }, "retitle-loom-first");
      await runtime.idle();
      await sendAndSettle(retitle, { title: "Second" }, "retitle-loom-second");
      await runtime.idle();
      expect(await sendAgain(retitle, { title: "First" }, "retitle-loom-first"))
        .toMatchObject(receiptExists);
      await runtime.idle();
      expect(await output.key("title").pull()).toBe("Second");
    });

    it("leaves the title a later `retitlePanel` set, and the panel's adder", async () => {
      const { output, panel } = await rootWithPanel("retitle-panel");
      const retitle = await output.key("retitlePanel").pull();
      await sendAndSettle(
        retitle,
        { panel, titleOverride: "First" },
        "retitle-panel-first",
      );
      await runtime.idle();
      await sendAndSettle(
        retitle,
        { panel, titleOverride: "Second" },
        "retitle-panel-second",
      );
      await runtime.idle();
      expect(
        await sendAgain(
          retitle,
          { panel, titleOverride: "First" },
          "retitle-panel-first",
        ),
      ).toMatchObject(receiptExists);
      await runtime.idle();
      expect(storedValue(panel)).toMatchObject({
        kind: "piece",
        titleOverride: "Second",
        addedBy: signer.did(),
      });
    });

    it("leaves the target a later `retargetPanel` set, with no key of the kind it left", async () => {
      const { output, panel } = await rootWithPanel("retarget-panel");
      const retarget = await output.key("retargetPanel").pull();
      const first = { kind: "url", url: "https://example.com/first" };
      await sendAndSettle(
        retarget,
        { panel, target: first },
        "retarget-panel-first",
      );
      await runtime.idle();
      await sendAndSettle(
        retarget,
        { panel, target: { kind: "url", url: "https://example.com/second" } },
        "retarget-panel-second",
      );
      await runtime.idle();
      expect(
        await sendAgain(
          retarget,
          { panel, target: first },
          "retarget-panel-first",
        ),
      ).toMatchObject(receiptExists);
      await runtime.idle();
      const stored = storedValue(panel);
      expect(stored).toMatchObject({
        kind: "url",
        url: "https://example.com/second",
        addedBy: signer.did(),
      });
      expect(stored).not.toHaveProperty("piece");
    });
  });
});
