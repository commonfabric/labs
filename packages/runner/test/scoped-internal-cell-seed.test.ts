/**
 * A pattern-owned cell scoped narrower than its result cell starts from its
 * default in every instance, not only in the instance of whoever set the
 * pattern up first.
 */
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../src/builder/types.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { applyCfcPolicyToExistingValue } from "../src/cfc/policy-application.ts";
import { setCfcImplementationIdentity } from "../src/cfc/trust-authority.ts";
import { Runtime } from "../src/runtime.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import { stampSpeculationRunContext } from "../src/speculation/overlay-destination.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("scoped internal cell seed");
const visitor = await Identity.fromPassphrase(
  "scoped internal cell seed visitor",
);
const space = owner.did();

interface Draft {
  title: string;
  members: string;
}

const EMPTY_DRAFT: Draft = { title: "", members: "" };

const draftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    members: { type: "string" },
  },
  required: ["title", "members"],
} as const satisfies JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    draft: { ...draftSchema, asCell: ["cell"] },
  },
  required: ["draft"],
} as const satisfies JSONSchema;

const privateDraftProgram = (protectedDraft = false) => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
          import { Confidential, CurrentPrincipal, handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
          type Private<T> = Confidential<T, readonly [{
            type: "https://commonfabric.org/cfc/atom/User";
            subject: CurrentPrincipal;
          }]>;
          export const save = handler<{ value: string }, { draft: Writable<string> }>(
            ({ value }, { draft }) => draft.set(value),
          );
          type Draft = ${
      protectedDraft
        ? "Private<WriteAuthorizedBy<string, typeof save>>"
        : "Private<string>"
    };
          type Output = { shared: Private<string>; draft: Writable<Draft> };
          const Editor = pattern<{ shared: Private<string> }, Output>(({ shared }) => {
            const draft = Writable.perUser.of<Draft>("");
            return { shared, draft };
          });
          export default pattern<Record<string, never>, Output>(() => {
            const shared = Writable.perSpace.of<Private<string>>("shared");
            return Editor({ shared });
          });
        `,
  }],
});

describe("scoped-internal-cell-seed", () => {
  let server: MemoryV2Server.Server;
  let opened: { runtime: Runtime; manager: EmulatedStorageManager }[];

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    opened = [];
  });

  afterEach(async () => {
    for (const { runtime, manager } of opened) {
      await manager.synced();
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** Opens a runtime with a memory session of its own, as a page load does. */
  function openRuntime(as: Identity, serverExecution = false) {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution },
    });
    opened.push({ runtime, manager });
    return runtime;
  }

  /** The pattern that holds a draft cell of the given scope. */
  function draftHolder(
    runtime: Runtime,
    scope: "space" | "user" | "session",
    initial = EMPTY_DRAFT,
  ) {
    const { pattern, Cell } = createTrustedBuilder(runtime).commonfabric;
    const scoped = scope === "space"
      ? Cell.perSpace
      : scope === "user"
      ? Cell.perUser
      : Cell.perSession;
    return pattern(
      () => ({ draft: scoped.of<Draft>(initial) }),
      { type: "object", properties: {} },
      resultSchema,
    );
  }

  /**
   * Loads the draft-holding piece in a runtime of its own, and returns the
   * piece's draft cell.
   */
  async function load(scope: "user" | "session", as: Identity) {
    const runtime = openRuntime(as);
    const resultCell = runtime.getCell(space, "draft holder", resultSchema);
    const result = await runtime.runSynced(
      resultCell,
      draftHolder(runtime, scope),
      {},
    );
    await runtime.idle();
    return { runtime, draft: result.key("draft") };
  }

  /** Writes `title` into the draft's own field, as a bound text input does. */
  async function writeTitle(
    { runtime, draft }: Awaited<ReturnType<typeof load>>,
    title: string,
  ) {
    const tx = runtime.edit();
    draft.withTx(tx).key("title").set(title);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  }

  for (
    const [scope, later] of [
      ["session", "a later session of the same user"],
      ["user", "another user"],
    ] as const
  ) {
    it(`reads a field written by ${later} beside the ${scope} cell's defaults`, async () => {
      const first = await load(scope, owner);
      await writeTitle(first, "first");
      const second = await load(scope, scope === "user" ? visitor : owner);
      await writeTitle(second, "second");

      expect(second.draft.get()).toEqual({ title: "second", members: "" });
      expect(first.draft.get()).toEqual({ title: "first", members: "" });
    });
  }

  it("keeps a user's per-user value when that user loads again", async () => {
    await writeTitle(await load("user", owner), "kept");
    const reloaded = await load("user", owner);

    expect(reloaded.draft.get()).toEqual({ title: "kept", members: "" });
  });

  for (const protectedDraft of [false, true]) {
    it(`starts another user's ${protectedDraft ? "protected " : ""}private draft beside a shared confidential value`, async () => {
      const first = openRuntime(owner);
      const compiled = await first.patternManager.compilePattern(
        privateDraftProgram(protectedDraft),
        { space },
      );
      const piece = first.getCell(space, "private draft holder");
      await first.runSynced(piece, compiled, {});
      await first.idle();

      const second = openRuntime(visitor);
      const failures: unknown[] = [];
      second.pieceStartCommitFailureObserver = ({ error }) =>
        failures.push(error);
      const reopened = second.getCell(space, "private draft holder");
      await reopened.sync();
      await second.runner.syncStoredPieceCells(reopened, compiled);
      expect(reopened.key("draft").resolveAsCell().getRawUntyped())
        .toBeUndefined();
      const tx = second.edit();
      second.run(tx, compiled, {}, reopened);
      second.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();

      expect(failures).toEqual([]);
      const privateDraft = reopened.key("draft").resolveAsCell();
      expect(privateDraft.getRawUntyped()).toBe("");
      const metadataTx = second.edit();
      try {
        const metadata = readStoredCfcMetadata(
          metadataTx,
          privateDraft.getAsNormalizedFullLink(),
        );
        const clauses = metadata?.labelMap.entries.flatMap((entry) =>
          entry.label.confidentiality ?? []
        );
        expect(clauses).toEqual(expect.arrayContaining([{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: visitor.did(),
        }]));
        expect(JSON.stringify(clauses)).not.toContain(owner.did());
      } finally {
        metadataTx.abort("private draft label assertions complete");
      }
      const write = second.edit();
      privateDraft.withTx(write).set("kept");
      const written = await write.commit().settled;
      if (protectedDraft) expect(written.error).toBeDefined();
      else expect(written.error).toBeUndefined();
      await second.idle();
      const third = openRuntime(visitor);
      third.pieceStartCommitFailureObserver = ({ error }) =>
        failures.push(error);
      const reloaded = third.getCell(space, "private draft holder");
      await reloaded.sync();
      const reloadTx = third.edit();
      third.run(reloadTx, compiled, {}, reloaded);
      third.prepareTxForCommit(reloadTx);
      expect((await reloadTx.commit().settled).error).toBeUndefined();
      await third.idle();
      expect(failures).toEqual([]);
      expect(reloaded.key("draft").resolveAsCell().getRawUntyped()).toBe(
        protectedDraft ? "" : "kept",
      );
    });
  }

  it("keeps a cold-started actor's private default linked to its owning piece", async () => {
    const first = openRuntime(owner);
    const compiled = await first.patternManager.compilePattern(
      privateDraftProgram(),
      { space },
    );
    const original = first.getCell(space, "cold private holder");
    await first.runSynced(original, compiled, {});
    await first.idle();
    const second = openRuntime(visitor);
    const piece = second.getCell(space, "cold private holder");
    await piece.sync();
    expect(await second.runner.start(piece)).toBe(true);
    await second.idle();
    const draft = piece.key("draft").resolveAsCell();
    expect(draft.getRawUntyped()).toBe("");
    expect(draft.getMetaRaw("result")).toEqual(
      original.key("draft").resolveAsCell().getMetaRaw("result"),
    );
    expect(draft.getMetaRaw("result")).toBeDefined();
  });

  for (
    const [explicitPublic, title] of [
      [
        false,
        "preserves the owning piece's confidentiality on a cold session default",
      ],
      [
        true,
        "labels an explicitly public cold session default without widening its declaration",
      ],
    ] as const
  ) {
    it(title, async () => {
      // The owner's session instance is read by the owner alone, so its
      // residency admits the owning piece's `User` label over any
      // declaration (§8.12.4), and the label lands as the value's derived
      // stamp. Nothing is declared, so a public declaration stays public.

      const first = openRuntime(owner);
      const compiled = await first.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `/// <cts-enable />
            import { Confidential, pattern, Writable } from "commonfabric";
            export default pattern<Record<string, never>>(() => ({
              tab: Writable.perSession.of<${
            explicitPublic ? "Confidential<string, readonly []>" : "string"
          }>("overview"),
            }));`,
        }],
      }, { space });
      const original = first.getCell(space, "private owner with session state");
      await first.runSynced(original, compiled, {});
      await first.idle();
      const ownerLabel = {
        type: "https://commonfabric.org/cfc/atom/User",
        subject: owner.did(),
      };
      const protect = first.edit();
      setCfcImplementationIdentity(protect, {
        kind: "builtin",
        builtinId: "scoped-seed-owner-policy",
      });
      applyCfcPolicyToExistingValue(
        original.withTx(protect).asSchema({
          ifc: { confidentiality: [ownerLabel] },
        }),
      );
      expect((await protect.commit().settled).error).toBeUndefined();
      await first.storageManager.synced();

      const second = openRuntime(owner);
      const piece = second.getCell(space, "private owner with session state");
      await piece.sync();
      expect(await second.runner.start(piece)).toBe(true);
      await second.idle();
      const tab = piece.key("tab").resolveAsCell();
      expect(tab.getRawUntyped()).toBe("overview");
      const inspect = second.edit();
      try {
        const entries = readStoredCfcMetadata(
          inspect,
          tab.getAsNormalizedFullLink(),
        )?.labelMap.entries;
        expect(entries).toEqual(expect.arrayContaining([
          expect.objectContaining({
            path: [],
            origin: "derived",
            observes: "value",
            label: expect.objectContaining({
              confidentiality: expect.arrayContaining([ownerLabel]),
            }),
          }),
        ]));
        expect(entries?.filter((entry) => entry.origin === "declared"))
          .toEqual([]);
      } finally {
        inspect.abort("cold session label assertions complete");
      }
    });
  }

  it("labels a cold session default with the owning piece's committed personal-space label", async () => {
    // A piece whose label crossed a space boundary holds its personal-space
    // owner as a `{digestOf}` commitment. A cold start seeds its session
    // default under that label, in the owner's own session instance, whose
    // residency admits it (§8.12.4), so the label lands as the value's
    // derived stamp.

    const first = openRuntime(owner);
    const compiled = await first.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { pattern, Writable } from "commonfabric";
          export default pattern<Record<string, never>>(() => ({
            tab: Writable.perSession.of<string>("overview"),
          }));`,
      }],
    }, { space });
    const original = first.getCell(space, "personal space with session state");
    await first.runSynced(original, compiled, {});
    await first.idle();
    const committedPersonalSpace = {
      type: "https://commonfabric.org/cfc/atom/PersonalSpace",
      owner: commitCfcFieldValue(space),
    };
    const protect = first.edit();
    setCfcImplementationIdentity(protect, {
      kind: "builtin",
      builtinId: "scoped-seed-owner-policy",
    });
    applyCfcPolicyToExistingValue(
      original.withTx(protect).asSchema({
        ifc: { confidentiality: [committedPersonalSpace] },
      }),
    );
    expect((await protect.commit().settled).error).toBeUndefined();
    await first.storageManager.synced();

    const second = openRuntime(owner);
    const piece = second.getCell(space, "personal space with session state");
    await piece.sync();
    expect(await second.runner.start(piece)).toBe(true);
    await second.idle();
    const tab = piece.key("tab").resolveAsCell();
    expect(tab.getRawUntyped()).toBe("overview");
    const inspect = second.edit();
    try {
      const metadata = readStoredCfcMetadata(
        inspect,
        tab.getAsNormalizedFullLink(),
      );
      expect(metadata?.labelMap.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: [],
          origin: "derived",
          observes: "value",
          label: expect.objectContaining({
            confidentiality: expect.arrayContaining([committedPersonalSpace]),
          }),
        }),
      ]));
    } finally {
      inspect.abort("committed personal space label assertions complete");
    }
  });

  it("initializes defaults in the run when dependency loading rejects", async () => {
    await load("user", owner);
    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    const pattern = draftHolder(second, "user");
    await second.runner.syncStoredPieceCells(piece, pattern);
    let attempts = 0;
    second.runner.accessForTestingOnly.dependencySyncer = () => {
      attempts++;
      return Promise.reject(new Error("dependency sync unavailable"));
    };
    try {
      const tx = second.edit();
      second.run(tx, pattern, {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();
    } finally {
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
    expect(attempts).toBe(1);
    expect(piece.key("draft").resolveAsCell().getRawUntyped()).toEqual(
      EMPTY_DRAFT,
    );
  });

  for (const kind of ["derivation", "event-handler"] as const) {
    it(`keeps a speculative ${kind}'s default out of durable storage`, async () => {
      await load("user", owner);
      const second = openRuntime(visitor, true);
      const piece = second.getCell(space, "draft holder", resultSchema);
      const pattern = draftHolder(second, "user");
      await second.runner.syncStoredPieceCells(piece, pattern);
      const tx = second.edit();
      stampSpeculationRunContext(tx, {
        actionId: "speculative-draft-start",
        kind,
        ...(kind === "event-handler" ? { eventId: "draft-event" } : {}),
      });
      second.run(tx, pattern, {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await second.idle();
      expect(piece.key("draft").resolveAsCell().getRawUntyped()).toEqual(
        EMPTY_DRAFT,
      );

      const durable = openRuntime(visitor);
      const stored = durable.getCell(space, "draft holder", resultSchema);
      await durable.runner.syncStoredPieceCells(
        stored,
        draftHolder(durable, "user"),
      );
      expect(stored.key("draft").resolveAsCell().getRawUntyped())
        .toBeUndefined();

      // An authored start in the same runtime must not reuse a speculative
      // landing as evidence that this actor's durable default was prepared.
      const authored = second.edit();
      second.run(authored, pattern, {}, piece);
      expect((await authored.commit().settled).error).toBeUndefined();
      await second.idle();
      await durable.runner.syncStoredPieceCells(
        stored,
        draftHolder(durable, "user"),
      );
      expect(stored.key("draft").resolveAsCell().getRawUntyped()).toEqual(
        EMPTY_DRAFT,
      );
    });
  }

  it("initializes the requested pattern when its stored manifest changes during naming", async () => {
    const first = await load("user", owner);
    const original = first.runtime.getCell(space, "draft holder", resultSchema);
    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    const requested = draftHolder(second, "user");
    await piece.sync();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      pattern,
      inputs,
      sync,
    ) => {
      entered.resolve();
      await release.promise;
      return await sync(cell, pattern, inputs);
    };
    try {
      const tx = second.edit();
      second.run(tx, requested, {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await entered.promise;
      await first.runtime.runSynced(
        original,
        draftHolder(first.runtime, "user", {
          title: "new default",
          members: "",
        }),
        {},
      );
      await first.runtime.idle();
      await piece.sync();
    } finally {
      release.resolve();
      await second.idle();
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
    expect(piece.key("draft").resolveAsCell().getRawUntyped()).toEqual(
      EMPTY_DRAFT,
    );
  });

  it("keeps a caller-owned setup's defaults inside its commit", async () => {
    await load("user", owner);
    const second = openRuntime(visitor);
    const piece = second.getCell(space, "draft holder", resultSchema);
    await piece.sync();
    const tx = second.edit();
    await second.runSynced(piece.withTx(tx), draftHolder(second, "user"), {}, {
      start: false,
    });
    tx.abort("caller declined setup");
    expect(piece.key("draft").resolveAsCell().getRawUntyped()).toBeUndefined();
  });

  for (const callerOwned of [true, false]) {
    it(`initializes another user's default through ${callerOwned ? "caller-owned" : "owned"} setup`, async () => {
      await load("user", owner);
      const second = openRuntime(visitor);
      const piece = second.getCell(space, "draft holder", resultSchema);
      const pattern = draftHolder(second, "user");
      await second.runner.syncStoredPieceCells(piece, pattern);
      const tx = callerOwned ? second.edit() : undefined;
      await second.runner.setup(tx, pattern, {}, piece);
      if (tx) expect((await tx.commit().settled).error).toBeUndefined();
      expect(piece.key("draft").resolveAsCell().getRawUntyped()).toEqual(
        EMPTY_DRAFT,
      );
    });
  }

  for (const overlap of [false, true]) {
    it(`initializes after ${overlap ? "joining" : "an abandoned"} caller-owned dependency load`, async () => {
      await load("user", owner);
      const second = openRuntime(visitor);
      const piece = second.getCell(space, "draft holder", resultSchema);
      const pattern = draftHolder(second, "user");
      await piece.sync();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      second.runner.accessForTestingOnly.dependencySyncer = async (
        cell,
        pattern,
        inputs,
        sync,
      ) => {
        entered.resolve();
        await release.promise;
        return await sync(cell, pattern, inputs);
      };
      const tx = second.edit();
      const pending = Promise.resolve(
        second.runner.runInTransaction(tx, pattern, {}, piece),
      )
        .then(() => {
          throw new Error("Expected dependency load retry");
        }, (error: unknown) => {
          expect(error).toBeInstanceOf(RetryImmediately);
        });
      try {
        await entered.promise;
        if (!overlap) {
          release.resolve();
          await pending;
          tx.abort("caller declined retry");
        }
        const runTx = second.edit();
        second.run(runTx, pattern, {}, piece);
        expect((await runTx.commit().settled).error).toBeUndefined();
      } finally {
        release.resolve();
        await pending;
        if (overlap) tx.abort("caller declined retry");
        await second.idle();
        second.runner.accessForTestingOnly.dependencySyncer = undefined;
      }
      expect(piece.key("draft").resolveAsCell().getRawUntyped()).toEqual(
        EMPTY_DRAFT,
      );
    });
  }

  it("leaves an actor's default absent when its start is stopped during synchronization", async () => {
    const first = openRuntime(owner);
    const compiled = await first.patternManager.compilePattern(
      privateDraftProgram(),
      { space },
    );
    await first.runSynced(
      first.getCell(space, "cancelled private holder"),
      compiled,
      {},
    );
    await first.idle();
    const second = openRuntime(visitor);
    const piece = second.getCell(space, "cancelled private holder");
    await piece.sync();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    second.runner.accessForTestingOnly.dependencySyncer = async (
      cell,
      pattern,
      inputs,
      sync,
    ) => {
      entered.resolve();
      await release.promise;
      return await sync(cell, pattern, inputs);
    };
    try {
      const tx = second.edit();
      second.run(tx, compiled, {}, piece);
      expect((await tx.commit().settled).error).toBeUndefined();
      await entered.promise;
      second.runner.stop(piece);
    } finally {
      release.resolve();
      await second.idle();
      second.runner.accessForTestingOnly.dependencySyncer = undefined;
    }
    expect(piece.key("draft").resolveAsCell().getRawUntyped()).toBeUndefined();
  });

  for (const [from, to] of [["user", "space"], ["session", "user"]] as const) {
    it(`reads a field written after the cell's scope changes from ${from} to ${to} beside its defaults`, async () => {
      // The same partial cause names the cell in both versions, so the
      // manifest entry the first version left is for the cell's other scope.

      const runtime = openRuntime(owner);
      const resultCell = runtime.getCell(
        space,
        "rescoped holder",
        resultSchema,
      );
      await runtime.runSynced(resultCell, draftHolder(runtime, from), {});
      const result = await runtime.runSynced(
        resultCell,
        draftHolder(runtime, to),
        {},
      );
      await runtime.idle();
      const draft = result.key("draft");
      await writeTitle({ runtime, draft }, "rescoped");

      expect(draft.resolveAsCell().getAsNormalizedFullLink().scope).toBe(to);
      expect(draft.get()).toEqual({ title: "rescoped", members: "" });
    });
  }
});
