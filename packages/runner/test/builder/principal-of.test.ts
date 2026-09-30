import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { PrincipalClaimKind } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";

import { currentPrincipal } from "../../src/builder/current-principal.ts";
import { pattern, popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { principalOf } from "../../src/builder/principal-of.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { setCfcImplementationIdentity } from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { isLinkResolutionProbe } from "../../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const alice = await Identity.fromPassphrase("principal-of alice");
const bob = await Identity.fromPassphrase("principal-of bob");
const space = alice.did() as MemorySpace;

const CURRENT_PRINCIPAL = { __ctCurrentPrincipal: true };

/** A stored label entry, as a seed writes it. */
type SeedEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
  observes?: string;
};

/** A claim of `kind` naming `subject`, in the form a runtime mints. */
const claim = (kind: PrincipalClaimKind, subject: string) => ({
  kind,
  subject,
});

/** An entry at `path` whose integrity is `atoms`. */
const claimsAt = (path: string[], ...atoms: unknown[]): SeedEntry => ({
  path,
  label: { integrity: atoms },
  origin: "declared",
});

/**
 * A pattern whose handler and `computed()` each call `principalOf()` on the
 * cell they are given, reporting what it returned or the message it threw.
 */
const PROBE_PATTERN = [
  "import {",
  "  computed, handler, pattern, principalOf, Stream, Writable,",
  "} from 'commonfabric';",
  "type Kind = 'authored-by' | 'represents-principal';",
  "const probe = (",
  "  target: Writable<{ name?: string }>,",
  "  kind: Kind,",
  "): string => {",
  "  try {",
  "    return `returned ${principalOf(target, kind)}`;",
  "  } catch (error) {",
  "    return `threw ${(error as Error).message}`;",
  "  }",
  "};",
  "const record = handler<",
  "  { target: Writable<{ name?: string }>; kind: Kind },",
  "  { seen: Writable<string> }",
  ">((event, { seen }) => { seen.set(probe(event.target, event.kind)); });",
  "export default pattern<",
  "  { seen: Writable<string>; profile: Writable<{ name?: string }> },",
  "  {",
  "    seen: string;",
  "    viaComputed: string;",
  "    record: Stream<unknown>;",
  "  }",
  ">(({ seen, profile }) => ({",
  "  seen,",
  "  viaComputed: computed(() => probe(profile, 'represents-principal')),",
  "  record: record({ seen }),",
  "}));",
].join("\n");

/**
 * A document whose `body` carries a principal claim of `kind` naming
 * `subject`, with the writer and gesture such a claim needs to commit, so the
 * only thing that can refuse the write is the check on the claim itself.
 */
const claimedSchema = (kind: PrincipalClaimKind, subject: unknown) =>
  ({
    type: "object",
    properties: {
      body: {
        type: "string",
        ifc: {
          addIntegrity: [{ kind, subject }],
          writeAuthorizedBy: {
            __ctWriterIdentityOf: { file: "/writer.tsx", path: ["writeBody"] },
          },
          uiContract: {
            helper: "UiAction",
            action: "WriteBody",
            trustedPattern: "Writer",
            requiredEventIntegrity: ["Writer"],
          },
        },
      },
    },
    required: ["body"],
  }) as JSONSchema;

describe("principalOf()", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  let openTxs: IExtendedStorageTransaction[];

  /** Opens a transaction the test aborts afterward. */
  const edit = (): IExtendedStorageTransaction => {
    const tx = runtime.edit();
    openTxs.push(tx);
    return tx;
  };

  /** Runs `fn` in a `kind` frame over `tx`, and returns its result. */
  const inFrame = <T>(
    tx: IExtendedStorageTransaction,
    kind: "handler" | "lift",
    fn: () => T,
  ): T => {
    const frame = pushFrame({
      runtime,
      tx,
      space,
      frameKind: kind,
      ...(kind === "handler" ? { inHandler: true } : {}),
    });
    try {
      return fn();
    } finally {
      popFrame(frame);
    }
  };

  /** Calls `principalOf(target, kind)` in a `frame` frame over `tx`. */
  const callIn = (
    tx: IExtendedStorageTransaction,
    target: unknown,
    kind: unknown,
    frame: "handler" | "lift" = "handler",
  ) =>
    inFrame(
      tx,
      frame,
      () => principalOf(target, kind),
    );

  /** Returns the id of the document `cause` names in the test's space. */
  const idOf = (cause: string): URI =>
    runtime.getCell(space, cause).getAsNormalizedFullLink().id;

  /**
   * Stores `value` at the document `cause` names, with a label map of
   * `entries`, as the runtime would store it, and returns the document's cell.
   */
  const seed = async (
    cause: string,
    entries: SeedEntry[],
    value: unknown = { name: "Alice", bio: "hello" },
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: [] },
      {
        value,
        ...(entries.length === 0 ? {} : {
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries },
          },
        }),
      } as never,
    );
    expect((await tx.commit()).error).toBeUndefined();
    return runtime.getCell(space, cause);
  };

  /**
   * Replaces the label map of the document `cause` names with one of
   * `entries`, leaving its value as it is.
   */
  const relabel = async (cause: string, entries: SeedEntry[]) => {
    const tx = runtime.edit();
    seedStoredEnvelope(
      tx,
      { space, scope: "space", id: idOf(cause), path: ["cfc"] },
      {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      } as never,
    );
    expect((await tx.commit()).error).toBeUndefined();
  };

  /**
   * Writes a document at `cause` under `claimedSchema(kind, subject)` from a
   * handler, and returns the document's cell, the principal that handler's
   * `currentPrincipal()` returned, and the commit's error, if any.
   */
  const writeClaimed = async (
    cause: string,
    kind: PrincipalClaimKind,
    subject: unknown = CURRENT_PRINCIPAL,
  ) => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, {
      kind: "verified",
      moduleIdentity: "principal-of-module",
      sourceFile: "/writer.tsx",
      bindingPath: ["writeBody"],
    });
    const author = inFrame(tx, "handler", currentPrincipal);
    const cell = runtime.getCell(
      space,
      cause,
      claimedSchema(kind, subject),
      tx,
    );
    cell.set({ body: "hello" });
    const target = cell.getAsNormalizedFullLink();
    tx.recordCfcWritePolicyInput({
      kind: "trusted-event",
      target: {
        space: target.space,
        scope: target.scope,
        id: target.id,
        path: ["body"],
      },
      eventId: "trusted-body-edit",
      provenance: {
        origin: "dom",
        trusted: true,
        ui: {
          pattern: "Writer",
          eventIntegrity: ["Writer"],
          uiContractDataset: { uiAction: "WriteBody" },
        },
      },
    });
    tx.prepareCfc();
    const { error } = await tx.commit();
    return { cell: runtime.getCell(space, cause), author, error };
  };

  beforeEach(() => {
    openTxs = [];
    storage = StorageManager.emulate({ as: alice });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    for (const tx of openTxs) tx.abort(new Error("test-only"));
    await runtime.idle();
    await runtime.dispose();
    await storage.close();
  });

  describe("reading a label", () => {
    it("returns the DID a `represents-principal` claim at the root attests", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      expect(callIn(edit(), profile, "represents-principal")).toBe(bob.did());
    });

    it("returns the DID the claims on a profile's top-level fields attest", async () => {
      const profile = await seed("profile", [
        claimsAt(["name"], claim("represents-principal", bob.did())),
        claimsAt(["bio"], claim("represents-principal", bob.did())),
      ]);
      expect(callIn(edit(), profile, "represents-principal")).toBe(bob.did());
    });

    it("returns the author an `authored-by` claim attests, and nothing for the other kind", async () => {
      const record = await seed("record", [
        claimsAt(["name"], claim("authored-by", bob.did())),
      ]);
      expect(callIn(edit(), record, "authored-by")).toBe(bob.did());
      expect(callIn(edit(), record, "represents-principal")).toBeUndefined();
    });

    it("returns the same DID in a reactive computation's frame", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      expect(callIn(edit(), profile, "represents-principal", "lift")).toBe(
        bob.did(),
      );
    });

    it("returns the DID the document a link leads to attests", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const holder = runtime.getCell<unknown>(space, "holder");
      const tx = runtime.edit();
      holder.withTx(tx).set(profile);
      expect((await tx.commit()).error).toBeUndefined();

      expect(callIn(edit(), holder, "represents-principal")).toBe(bob.did());
    });

    it("returns `undefined` for a document whose label attests no principal", async () => {
      const unlabeled = await seed("unlabeled", []);
      const other = await seed("other", [
        { path: ["name"], label: { confidentiality: ["secret"] } },
      ]);
      expect(callIn(edit(), unlabeled, "represents-principal"))
        .toBeUndefined();
      expect(callIn(edit(), other, "represents-principal")).toBeUndefined();
    });

    it("returns `undefined` for a label attesting two principals", async () => {
      const profile = await seed("profile", [
        claimsAt(["name"], claim("represents-principal", alice.did())),
        claimsAt(["bio"], claim("represents-principal", bob.did())),
      ]);
      expect(callIn(edit(), profile, "represents-principal")).toBeUndefined();
    });

    it("returns `undefined` for a label holding a claim in any form but the one a runtime mints", async () => {
      const forms = [
        `represents-principal:${bob.did()}`,
        { kind: "represents-principal", subject: ` ${bob.did()}` },
        { kind: "represents-principal", subject: bob.did(), scope: "x" },
        { kind: "represents-principal", subject: "not-a-did" },
      ];
      for (const [index, form] of forms.entries()) {
        const profile = await seed(`profile-${index}`, [
          claimsAt([], claim("represents-principal", bob.did())),
          claimsAt(["name"], form),
        ]);
        expect(callIn(edit(), profile, "represents-principal"))
          .toBeUndefined();
      }
    });

    it("returns `undefined` for a claim below the top-level fields, or one a link carries", async () => {
      const deep = await seed("deep", [
        claimsAt(["name", "first"], claim("represents-principal", bob.did())),
      ], { name: { first: "Bob" } });
      const carried = await seed("carried", [{
        ...claimsAt(["name"], claim("represents-principal", bob.did())),
        observes: "followRef",
      }]);
      expect(callIn(edit(), deep, "represents-principal")).toBeUndefined();
      expect(callIn(edit(), carried, "represents-principal")).toBeUndefined();
    });

    it("returns `undefined` for a `target` passed as `undefined`", () => {
      expect(callIn(edit(), undefined, "represents-principal"))
        .toBeUndefined();
    });
  });

  describe("claims the runtime minted", () => {
    it("returns the author of a record a handler wrote with `AuthoredByCurrentUser`, which is that handler's `currentPrincipal()`", async () => {
      const { cell, author, error } = await writeClaimed(
        "authored",
        "authored-by",
      );
      expect(error).toBeUndefined();
      expect(author).toBe(alice.did());
      expect(callIn(edit(), cell, "authored-by")).toBe(author);
    });

    it("returns the principal a profile written with `RepresentsCurrentUser` represents", async () => {
      const { cell, author, error } = await writeClaimed(
        "represented",
        "represents-principal",
      );
      expect(error).toBeUndefined();
      expect(callIn(edit(), cell, "represents-principal")).toBe(author);
    });

    it("returns `undefined` for a record whose pattern-written claim names a DID, since the write is refused", async () => {
      // The same write with the runtime's placeholder commits, above; only
      // the literal subject differs.

      const { cell, error } = await writeClaimed(
        "forged",
        "authored-by",
        bob.did(),
      );
      expect(error).toBeDefined();
      expect(callIn(edit(), cell, "authored-by")).toBeUndefined();
    });

    it("returns a DID that a pattern cannot write back into a label as a claim's subject", async () => {
      const { cell } = await writeClaimed("original", "authored-by");
      const returned = callIn(edit(), cell, "authored-by");
      expect(returned).toBe(alice.did());

      const copy = await writeClaimed("copy", "authored-by", returned);
      expect(copy.error).toBeDefined();
      expect(callIn(edit(), copy.cell, "authored-by")).toBeUndefined();
    });
  });

  describe("what it reads", () => {
    it("reads the label, and not the value, through the calling code's transaction", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const id = idOf("profile");
      for (const frame of ["handler", "lift"] as const) {
        const tx = edit();
        expect(callIn(tx, profile, "represents-principal", frame)).toBe(
          bob.did(),
        );
        const reads = [...tx.getReadActivities!()].filter((read) =>
          read.id === id
        );
        expect(reads).toContainEqual(
          expect.objectContaining({ path: ["cfc"] }),
        );
        // Resolving the cell probes whether its value is a link, and reads
        // nothing else of the value.
        expect(
          reads.filter((read) =>
            read.path[0] === "value" && !isLinkResolutionProbe(read.meta)
          ),
        ).toEqual([]);
      }
    });

    it("runs a `lift()` that called it again when the label alone changes", async () => {
      // A second lift holds the same cell and reads nothing of it but the
      // link probe, so it shows that the change reaches only a computation
      // that read the label.

      await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const runs = { principal: 0, held: 0 };
      const argumentSchema = {
        type: "object",
        properties: { target: { type: "unknown", asCell: ["cell"] } },
      } as const satisfies JSONSchema;
      const { lift, pattern: trustedPattern } =
        createTrustedBuilder(runtime).commonfabric;
      const principal = lift(
        (input: { target?: unknown }) => {
          runs.principal++;
          return principalOf(
            input.target as Cell<unknown>,
            "represents-principal",
          ) ??
            "none";
        },
        argumentSchema,
        { type: "string" },
      );
      const held = lift(
        (input: { target?: unknown }) => {
          runs.held++;
          (input.target as Cell<unknown>).resolveAsCell();
          return "held";
        },
        argumentSchema,
        { type: "string" },
      );
      const probe = trustedPattern(
        ({ target }) => ({
          principal: principal({ target }),
          held: held({ target }),
        }),
        argumentSchema,
        {
          type: "object",
          properties: {
            principal: { type: "string" },
            held: { type: "string" },
          },
        },
      );
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        probe,
        { target: runtime.getCell(space, "profile") },
        runtime.getCell(space, "principal-of-lift", undefined, tx),
      ) as Cell<{ principal?: string; held?: string }>;
      expect((await tx.commit()).error).toBeUndefined();
      const cancel = result.sink(() => {});
      try {
        await waitForCellValue(
          runtime,
          result.key("principal"),
          (value) => value === bob.did(),
          { stuckLabel: "the lift to return bob's DID" },
        );
        expect(runs).toEqual({ principal: 1, held: 1 });

        await relabel("profile", [
          claimsAt([], claim("represents-principal", alice.did())),
        ]);
        await waitForCellValue(
          runtime,
          result.key("principal"),
          (value) => value === alice.did(),
          { stuckLabel: "the lift to follow the label to alice's DID" },
        );
        expect(runs).toEqual({ principal: 2, held: 1 });
      } finally {
        cancel();
      }
    });

    it("records no label-metadata observation, since a claim's subject is public", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const tx = edit();
      expect(callIn(tx, profile, "represents-principal")).toBe(bob.did());
      expect(tx.getCfcState().labelMetadataObservations).toEqual([]);
    });
  });

  describe("in a compiled pattern", () => {
    /** Compiles and runs `PROBE_PATTERN` over `profile`. */
    const runProbe = async (profile: Cell<unknown>) => {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: PROBE_PATTERN }],
      }, { space });
      const argument = runtime.getCell<{ seen: string; profile: unknown }>(
        space,
        "principal-of-probe-argument",
      );
      const result = runtime.getCell<{
        seen: string;
        viaComputed: string;
        record: unknown;
      }>(space, "principal-of-probe-result", compiled.resultSchema);
      {
        const tx = runtime.edit();
        argument.withTx(tx).set({ seen: "no event yet", profile });
        expect((await tx.commit()).error).toBeUndefined();
      }
      {
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        expect((await tx.commit()).error).toBeUndefined();
      }
      const cancel = result.sink(() => {});
      await runtime.idle();
      return { result, cancel };
    };

    it("returns the principal to a handler, on a cell its event names", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const record = await seed("record", [
        claimsAt(["name"], claim("authored-by", alice.did())),
      ]);
      const { result, cancel } = await runProbe(profile);
      try {
        result.key("record").send({
          target: record,
          kind: "authored-by",
        } as never);
        await runtime.idle();
        expect(result.key("seen").get()).toBe(`returned ${alice.did()}`);
      } finally {
        cancel();
      }
    });

    it("returns the principal to a `computed()`", async () => {
      const profile = await seed("profile", [
        claimsAt([], claim("represents-principal", bob.did())),
      ]);
      const { result, cancel } = await runProbe(profile);
      try {
        await waitForCellValue(
          runtime,
          result.key("viaComputed"),
          (value) => value === `returned ${bob.did()}`,
          { stuckLabel: "the computed to return bob's DID" },
        );
      } finally {
        cancel();
      }
    });
  });

  describe("where it can be called", () => {
    it("throws outside a handler or a reactive computation", () => {
      expect(() => principalOf(undefined, "represents-principal")).toThrow(
        "can only be called from a handler or a reactive computation",
      );
    });

    it("throws in a pattern body, even one built inside a handler", () => {
      const tx = edit();
      inFrame(tx, "handler", () => {
        expect(() =>
          pattern(() => {
            principalOf(undefined, "represents-principal");
            return {};
          })
        ).toThrow(
          "can only be called from a handler or a reactive computation",
        );
      });
    });

    it("throws for a `kind` that is not a principal claim kind", () => {
      expect(() => callIn(edit(), undefined, "owner")).toThrow(
        "takes a `kind` of `authored-by` or `represents-principal`",
      );
    });

    it("throws for a `target` that is not a cell", () => {
      expect(() => callIn(edit(), { name: "Bob" }, "authored-by")).toThrow(
        "takes a cell as its target",
      );
    });
  });
});
