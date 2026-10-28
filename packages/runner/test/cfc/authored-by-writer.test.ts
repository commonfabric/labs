import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { principalOf } from "../../src/builder/principal-of.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const alice = await Identity.fromPassphrase("authored-by-writer alice");
const bob = await Identity.fromPassphrase("authored-by-writer bob");
const service = await Identity.fromPassphrase("authored-by-writer service");

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

const WRITER = {
  __ctWriterIdentityOf: { file: "/writer.tsx", path: ["post"] },
};

const CONTRACT = {
  helper: "UiAction",
  action: "Post",
  trustedPattern: "Poster",
  requiredEventIntegrity: ["Poster"],
};

/**
 * A string carrying `ifc`, as `AuthoredByCurrentUser<WriteAuthorizedBy<…>>`
 * lowers to with `ifc` left as it is, or `TrustedActionWrite` with a
 * `uiContract` added.
 */
const noteSchema = (
  ifc: Record<string, unknown> = {
    addIntegrity: [{ kind: "authored-by", subject: CURRENT_PRINCIPAL }],
    writeAuthorizedBy: WRITER,
  },
  extra: Record<string, unknown> = {},
): JSONSchema => ({ type: "string", ...extra, ifc } as JSONSchema);

/**
 * profile-home's field shape: `owner` bound by the first write, a claim
 * representing them, and one declared writer.
 */
const ownedSchema = (
  owner: unknown = CURRENT_PRINCIPAL,
  extra: Record<string, unknown> = {},
): JSONSchema =>
  noteSchema({
    ownerPrincipal: owner,
    addIntegrity: [{ kind: "represents-principal", subject: owner }],
    writeAuthorizedBy: WRITER,
  }, extra);

/**
 * A pattern whose `post` handler is the declared writer of every note it
 * appends, with no gesture, and whose `relay` reaches `post` with a
 * `send()`. `seen` records what `principalOf()` returns for the first note.
 */
const NOTES_PATTERN = [
  "import {",
  "  AuthoredByCurrentUser, handler, pattern, principalOf, Stream, Writable,",
  "  WriteAuthorizedBy,",
  "} from 'commonfabric';",
  "type Note = AuthoredByCurrentUser<",
  "  WriteAuthorizedBy<{ text: string }, typeof post>",
  ">;",
  "type Posted = { text: string; author?: string };",
  "interface Notes {",
  "  notes: Writable<Note[]>;",
  "}",
  "const post = handler<Posted, Notes>(",
  "  (event, { notes }) => { notes.push({ text: event.text }); },",
  ");",
  "const relay = handler<Posted, { next: Stream<Posted> }>(",
  "  (event, { next }) => { next.send(event); },",
  ");",
  "const check = handler<unknown, {",
  "  notes: Writable<Note[]>;",
  "  seen: Writable<string>;",
  "}>((_event, { notes, seen }) => {",
  "  seen.set(principalOf(notes.key(0), 'authored-by') ?? 'none');",
  "});",
  "export default pattern<",
  "  { notes: Writable<Note[]>; seen: Writable<string> },",
  "  {",
  "    notes: Note[];",
  "    seen: string;",
  "    post: Stream<Posted>;",
  "    relay: Stream<Posted>;",
  "    check: Stream<unknown>;",
  "  }",
  ">(({ notes, seen }) => {",
  "  const next = post({ notes });",
  "  return {",
  "    notes,",
  "    seen,",
  "    post: next,",
  "    relay: relay({ next }),",
  "    check: check({ notes, seen }),",
  "  };",
  "});",
].join("\n");

/**
 * Every subject of a `kind` claim the stored label of `cell`'s document
 * names.
 */
const claimSubjects = (
  runtime: Runtime,
  cell: Cell<unknown>,
  kind: string,
): string[] => {
  const inspect = runtime.edit();
  try {
    const stored = readStoredCfcMetadata(
      inspect,
      cell.getAsNormalizedFullLink(),
    );
    return (stored?.labelMap.entries ?? [])
      .flatMap((entry) => entry.label.integrity ?? [])
      .flatMap((atom) => {
        const claim = atom as { kind?: unknown; subject?: unknown };
        return claim.kind === kind ? [claim.subject] : [];
      })
      .map(String)
      .sort();
  } finally {
    inspect.abort();
  }
};

/** Every `authored-by` subject the stored label of `cell`'s document names. */
const authoredBy = (runtime: Runtime, cell: Cell<unknown>): string[] =>
  claimSubjects(runtime, cell, "authored-by");

/** Every principal the stored label of `cell`'s document says it represents. */
const representedBy = (runtime: Runtime, cell: Cell<unknown>): string[] =>
  claimSubjects(runtime, cell, "represents-principal");

describe("authored-by-writer", () => {
  let client: Runtime;
  let clientStorage: ReturnType<typeof StorageManager.emulate>;
  let serving: Runtime;
  let servingStorage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    clientStorage = StorageManager.emulate({ as: bob });
    client = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientStorage,
    });
    servingStorage = StorageManager.emulate({ as: service });
    serving = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: servingStorage,
      servingPosture: true,
    });
  });

  afterEach(async () => {
    await clientStorage.synced();
    await client.dispose();
    await clientStorage.close();
    await serving.dispose();
    await servingStorage.close();
  });

  /**
   * Writes `value` to the document `cause` names in `runtime`'s own space,
   * under `schema`, as the writer `as` names (`post` unless given). `setup`
   * runs first, on the fresh transaction: it is where a test stamps a served
   * run or marks a handler's initialization. Returns the commit's error, if
   * any, and the document's cell.
   */
  const write = async (
    runtime: Runtime,
    cause: string,
    schema: JSONSchema,
    options: {
      as?: string;
      gesture?: boolean;
      setup?: (tx: IExtendedStorageTransaction) => void;
    } = {},
  ): Promise<{ error?: string; cell: Cell<unknown> }> => {
    const space = runtime.userIdentityDID;
    const tx = runtime.edit();
    options.setup?.(tx);
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "authored-by-writer-module",
      sourceFile: "/writer.tsx",
      bindingPath: [options.as ?? "post"],
    });
    const cell = runtime.getCell(space, cause, schema, tx);
    cell.set("a note");
    if (options.gesture === true) {
      const target = cell.getAsNormalizedFullLink();
      tx.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: target.space,
          scope: target.scope,
          id: target.id,
          path: [],
        },
        eventId: "trusted-post",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "Poster",
            eventIntegrity: ["Poster"],
            uiContractDataset: { uiAction: "Post" },
          },
        },
      });
    }
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    return { error: error?.message, cell: runtime.getCell(space, cause) };
  };

  /** Stamps `tx` as a served handler run acting for `actor`, or for no one. */
  const servedRun = (actor?: Identity) => (tx: IExtendedStorageTransaction) => {
    if (actor !== undefined) {
      setCfcTrustSnapshot(tx, serving.trustSnapshotForPrincipal(actor.did()));
    }
    stampWaveRunContext(tx, {
      actionId: "handler/authored-by-writer",
      kind: "event-handler",
      eventId: "event-1",
      ...(actor !== undefined ? { acting: { user: actor.did() } } : {}),
    });
  };

  /**
   * Initializes the document `cause` names in `serving`'s own space with
   * `schema`'s default, in the run `setup` stamps (a served run with no actor
   * unless given), as the run's own act (`attributed`) or on nobody's behalf.
   * Returns the commit's error, if any, and the cell.
   */
  const initialize = async (
    cause: string,
    schema: JSONSchema,
    attributed: boolean,
    setup: (tx: IExtendedStorageTransaction) => void = servedRun(),
  ): Promise<{ error?: string; cell: Cell<unknown> }> => {
    const tx = serving.edit();
    setup(tx);
    if (attributed) {
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
    }
    const space = serving.userIdentityDID;
    const cell = serving.getCell(space, cause, schema, tx);
    serving.getCell(space, `${cause}-holder`, undefined, tx).set({ cell });
    serving.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    return { error: error?.message, cell };
  };

  /**
   * Stamps `tx` as one of the serving loop's own runs, which acts for no one,
   * carrying the trust snapshot of `principal`, as the space-root ensure
   * carries the owner it resolves.
   */
  const bookkeepingRunFor =
    (principal: Identity) => (tx: IExtendedStorageTransaction) => {
      stampWaveRunContext(tx, {
        actionId: "space-root-ensure/authored-by-writer",
        kind: "bookkeeping",
      });
      setCfcTrustSnapshot(
        tx,
        serving.trustSnapshotForPrincipal(principal.did()),
      );
    };

  describe("a position whose writer declares no gesture", () => {
    it("labels the declared writer's write `authored-by` the runtime's own user on a client", async () => {
      const { error, cell } = await write(client, "client-note", noteSchema());
      expect(error).toBeUndefined();
      expect(authoredBy(client, cell)).toEqual([bob.did()]);
    });

    it("labels the declared writer's write `authored-by` the stamped actor on a served run", async () => {
      const { error, cell } = await write(
        serving,
        "served-note",
        noteSchema(),
        {
          setup: servedRun(alice),
        },
      );
      expect(error).toBeUndefined();
      expect(authoredBy(serving, cell)).toEqual([alice.did()]);
    });

    it("labels a value a handler run initializes `authored-by` the acting principal, with no writer", async () => {
      const tx = client.edit();
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      const space = client.userIdentityDID;
      const seed = client.getCell(
        space,
        "initialized-note",
        noteSchema(undefined, { default: "a default" }),
        tx,
      );
      client.getCell(space, "initialized-note-holder", undefined, tx)
        .set({ seed });
      client.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(authoredBy(client, seed)).toEqual([bob.did()]);
    });

    it("refuses a write from a writer the position does not name", async () => {
      const { error } = await write(client, "rogue-note", noteSchema(), {
        as: "rogue",
      });
      expect(error).toContain("writeAuthorizedBy");
    });

    it("refuses a position that names no writer", async () => {
      const { error } = await write(
        client,
        "writerless-note",
        noteSchema({
          addIntegrity: [{ kind: "authored-by", subject: CURRENT_PRINCIPAL }],
        }),
      );
      expect(error).toContain(
        "current-principal integrity requires writeAuthorizedBy",
      );
    });
  });

  describe("a position whose writer declares a gesture", () => {
    const reviewed = noteSchema({
      addIntegrity: [{ kind: "authored-by", subject: CURRENT_PRINCIPAL }],
      writeAuthorizedBy: WRITER,
      uiContract: CONTRACT,
    });

    it("refuses the declared writer's write without the gesture", async () => {
      const { error } = await write(client, "ungestured-note", reviewed);
      expect(error).toContain("missing trusted-event policy input");
    });

    it("labels the declared writer's write with the gesture `authored-by` the acting principal", async () => {
      const { error, cell } = await write(client, "gestured-note", reviewed, {
        gesture: true,
      });
      expect(error).toBeUndefined();
      expect(authoredBy(client, cell)).toEqual([bob.did()]);
    });
  });

  describe("a served run with no actor", () => {
    it("refuses the declared writer's write", async () => {
      const { error } = await write(serving, "actorless-note", noteSchema(), {
        setup: servedRun(),
      });
      expect(error).toContain(
        "current-principal integrity requires the run's actor",
      );
    });

    it("refuses a value it initializes in a handler run", async () => {
      const tx = serving.edit();
      servedRun()(tx);
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      const space = serving.userIdentityDID;
      const seed = serving.getCell(
        space,
        "actorless-seed",
        noteSchema(undefined, { default: "a default" }),
        tx,
      );
      serving.getCell(space, "actorless-seed-holder", undefined, tx)
        .set({ seed });
      serving.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error?.message).toContain(
        "current-principal integrity requires the run's actor",
      );
    });

    it("admits a value it initializes on nobody's behalf, with no claim", async () => {
      const tx = serving.edit();
      servedRun()(tx);
      const space = serving.userIdentityDID;
      const seed = serving.getCell(
        space,
        "unattributed-seed",
        noteSchema(undefined, { default: "a default" }),
        tx,
      );
      serving.getCell(space, "unattributed-seed-holder", undefined, tx)
        .set({ seed });
      serving.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const inspect = serving.edit();
      expect(inspect.readValueOrThrow(seed.getAsNormalizedFullLink())).toBe(
        "a default",
      );
      inspect.abort();
      expect(authoredBy(serving, seed)).toEqual([]);
    });

    describe("at a position that declares an `ownerPrincipal`", () => {
      it("refuses the declared writer's write to a field with no owner, and leaves it for a user to claim", async () => {
        const refused = await write(serving, "unowned-field", ownedSchema(), {
          setup: servedRun(),
        });
        expect(refused.error).toContain(
          "ownerPrincipal requires the run's actor",
        );
        expect(representedBy(serving, refused.cell)).toEqual([]);

        const claimed = await write(serving, "unowned-field", ownedSchema(), {
          setup: servedRun(alice),
        });
        expect(claimed.error).toBeUndefined();
        expect(representedBy(serving, claimed.cell)).toEqual([alice.did()]);
      });

      it("refuses the declared writer's write to a field a user owns", async () => {
        const owned = await write(serving, "owned-field", ownedSchema(), {
          setup: servedRun(alice),
        });
        expect(owned.error).toBeUndefined();

        const { error } = await write(serving, "owned-field", ownedSchema(), {
          setup: servedRun(),
        });
        expect(error).toContain("ownerPrincipal requires the run's actor");
        expect(representedBy(serving, owned.cell)).toEqual([alice.did()]);
      });

      it("refuses a value it initializes in a handler run", async () => {
        const { error, cell } = await initialize(
          "attributed-owned-seed",
          ownedSchema(CURRENT_PRINCIPAL, { default: "a default" }),
          true,
        );
        expect(error).toContain("ownerPrincipal requires the run's actor");
        expect(representedBy(serving, cell)).toEqual([]);
      });

      it("admits a value it initializes on nobody's behalf, binding no owner", async () => {
        const { error, cell } = await initialize(
          "unattributed-owned-seed",
          ownedSchema(CURRENT_PRINCIPAL, { default: "a default" }),
          false,
        );
        expect(error).toBeUndefined();
        expect(representedBy(serving, cell)).toEqual([]);
      });

      it("refuses a value it initializes on nobody's behalf under a literal owner that names the serving runtime", async () => {
        const { error } = await initialize(
          "literal-owned-seed",
          ownedSchema(service.did(), { default: "a default" }),
          false,
        );
        expect(error).toContain("ownerPrincipal requires the run's actor");
      });
    });
  });

  describe("a serving-loop run under a principal's trust snapshot", () => {
    it("labels a value it initializes as its own act `authored-by` that principal", async () => {
      const { error, cell } = await initialize(
        "bookkeeping-note",
        noteSchema(undefined, { default: "a default" }),
        true,
        bookkeepingRunFor(alice),
      );
      expect(error).toBeUndefined();
      expect(authoredBy(serving, cell)).toEqual([alice.did()]);
    });

    it("binds that principal as the owner of a field it initializes as its own act", async () => {
      const { error, cell } = await initialize(
        "bookkeeping-owned-seed",
        ownedSchema(CURRENT_PRINCIPAL, { default: "a default" }),
        true,
        bookkeepingRunFor(alice),
      );
      expect(error).toBeUndefined();
      expect(representedBy(serving, cell)).toEqual([alice.did()]);
    });
  });

  describe("a demanded derivation with no actor, under its demander's trust snapshot", () => {
    // The serving loop attaches the demander's snapshot to a derivation it
    // runs for a demanded instance, before the seal settles whether the run
    // acts for anyone; the snapshot alone does not make it act for them.

    /** Stamps `tx` as such a derivation, demanded by `alice`. */
    const demandedDerivation = (tx: IExtendedStorageTransaction) => {
      stampWaveRunContext(tx, {
        actionId: "derivation/authored-by-writer",
        kind: "derivation",
        attributionFromScope: true,
      });
      setCfcTrustSnapshot(tx, serving.trustSnapshotForPrincipal(alice.did()));
    };

    it("refuses the declared writer's write", async () => {
      const { error, cell } = await write(
        serving,
        "derivation-note",
        noteSchema(),
        { setup: demandedDerivation },
      );
      expect(error).toContain(
        "current-principal integrity requires the run's actor",
      );
      expect(authoredBy(serving, cell)).toEqual([]);
    });

    it("refuses the declared writer's write to a field with no owner", async () => {
      const { error, cell } = await write(
        serving,
        "derivation-owned-field",
        ownedSchema(),
        { setup: demandedDerivation },
      );
      expect(error).toContain("ownerPrincipal requires the run's actor");
      expect(representedBy(serving, cell)).toEqual([]);
    });
  });

  describe("a claim naming someone other than the acting principal", () => {
    // `bob`'s client runtime makes every write here; none may produce a claim
    // naming `alice`.

    it("refuses a literal subject", async () => {
      const { error } = await write(
        client,
        "literal-note",
        noteSchema({
          addIntegrity: [{ kind: "authored-by", subject: alice.did() }],
          writeAuthorizedBy: WRITER,
        }),
      );
      expect(error).toContain(
        "current-principal integrity subject must be runtime resolved",
      );
    });

    it("refuses the string form of a claim", async () => {
      const { error } = await write(
        client,
        "string-note",
        noteSchema({
          addIntegrity: [`authored-by:${alice.did()}`],
          writeAuthorizedBy: WRITER,
        }),
      );
      expect(error).toContain(
        "current-principal integrity must be an object of kind and subject",
      );
    });

    it("refuses a literal `ownerPrincipal` that is not the acting principal", async () => {
      const { error } = await write(
        client,
        "owner-note",
        noteSchema({
          ownerPrincipal: alice.did(),
          addIntegrity: [
            { kind: "authored-by", subject: alice.did() },
            { kind: "represents-principal", subject: alice.did() },
          ],
          writeAuthorizedBy: WRITER,
        }),
      );
      expect(error).toContain("ownerPrincipal mismatch");
    });

    it("resolves a placeholder that also names another principal to the acting principal", async () => {
      const { error, cell } = await write(
        client,
        "forged-placeholder-note",
        noteSchema({
          addIntegrity: [{
            kind: "authored-by",
            subject: { ...CURRENT_PRINCIPAL, principal: alice.did() },
          }],
          writeAuthorizedBy: WRITER,
        }),
      );
      expect(error).toBeUndefined();
      expect(authoredBy(client, cell)).toEqual([bob.did()]);
    });
  });

  describe("in a compiled pattern", () => {
    // `post` takes no gesture, and every send here is a plain one. The
    // payload names `alice`, which nothing may read as the author.

    const payload = { text: "hello", author: alice.did() };

    /** Stands the pattern up on the client, and returns its result cell. */
    const standUp = async (): Promise<Cell<Record<string, unknown>>> => {
      const space = bob.did();
      const compiled = await client.patternManager.compilePattern({
        main: "/writer.tsx",
        files: [{ name: "/writer.tsx", contents: NOTES_PATTERN }],
      }, { space });
      const argument = client.getCell<{ notes: unknown[]; seen: string }>(
        space,
        "notes-argument",
        undefined,
      );
      const result = client.getCell<Record<string, unknown>>(
        space,
        "notes-result",
        compiled.resultSchema,
      );
      {
        const tx = client.edit();
        argument.withTx(tx).set({ notes: [], seen: "" });
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      {
        const tx = client.edit();
        client.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      return result;
    };

    /** Returns what `principalOf()` returns for the first note, in a handler. */
    const principalOfFirstNote = (
      result: Cell<Record<string, unknown>>,
    ): unknown => {
      const tx = client.edit();
      const frame = pushFrame({
        runtime: client,
        tx,
        space: bob.did(),
        inHandler: true,
        frameKind: "handler",
      });
      try {
        return principalOf(result.key("notes").key(0), "authored-by");
      } finally {
        popFrame(frame);
        tx.abort();
      }
    };

    for (const stream of ["post", "relay"] as const) {
      it(`labels the note \`post\` writes when sent to \`${stream}\` \`authored-by\` the acting principal`, async () => {
        const result = await standUp();
        const cancel = result.sink(() => {});
        try {
          await client.idle();
          result.key(stream).send(payload);
          await client.idle();
          expect(result.key("notes").get()).toEqual([{ text: "hello" }]);
          expect(principalOfFirstNote(result)).toBe(bob.did());
          result.key("check").send({});
          await client.idle();
          expect(result.key("seen").get()).toBe(bob.did());
        } finally {
          cancel();
        }
      });
    }
  });
});
