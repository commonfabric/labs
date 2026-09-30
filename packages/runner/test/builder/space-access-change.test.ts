import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { ACL } from "@commonfabric/memory/acl";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { ACLManager } from "../../src/acl-manager.ts";
import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceAccess } from "../../src/builder/space-access.ts";
import {
  commitSpaceAccessChanges,
  grantSpaceAccess,
  revokeSpaceAccess,
} from "../../src/builder/space-access-change.ts";
import type { Frame } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import type { SessionFactory } from "../../src/storage/v2.ts";
import { TestStorageManager } from "../memory-v2-test-utils.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const AUDIENCE = "did:key:z6Mk-runner-space-access-change-audience";

const alice = await Identity.fromPassphrase("space-access-change alice");
const bob = await Identity.fromPassphrase("space-access-change bob");
const carol = await Identity.fromPassphrase("space-access-change carol");

/**
 * A pattern whose `grant` and `revoke` handlers change the access list of the
 * space `notes` lives in and then record a note there, and whose `probe` is a
 * `computed()` calling `grantSpaceAccess()`, reporting what it threw.
 */
const ACCESS_PATTERN = [
  "import {",
  "  computed, grantSpaceAccess, handler, pattern, revokeSpaceAccess,",
  "  Stream, Writable,",
  "} from 'commonfabric';",
  "import type { DID, SpaceGrantLevel } from 'commonfabric';",
  "type Change = { principal: DID; level?: SpaceGrantLevel };",
  "const grant = handler<Change, { notes: Writable<string[]> }>(",
  "  (event, { notes }) => {",
  "    grantSpaceAccess(notes, event.principal, event.level ?? 'WRITE');",
  "    notes.push(`granted ${event.principal}`);",
  "  },",
  ");",
  "const revoke = handler<Change, { notes: Writable<string[]> }>(",
  "  (event, { notes }) => {",
  "    revokeSpaceAccess(notes, event.principal);",
  "    notes.push(`revoked ${event.principal}`);",
  "  },",
  ");",
  "const relay = handler<Change, { grant: Stream<Change> }>(",
  "  (event, { grant }) => { grant.send(event); },",
  ");",
  "export default pattern<",
  "  { notes: Writable<string[]> },",
  "  {",
  "    notes: string[];",
  "    probe: string;",
  "    grant: Stream<Change>;",
  "    revoke: Stream<Change>;",
  "    relay: Stream<Change>;",
  "  }",
  ">(({ notes }) => {",
  "  const grantStream = grant({ notes });",
  "  return {",
  "  notes,",
  "  probe: computed(() => {",
  "    try {",
  "      grantSpaceAccess(notes, 'did:key:z6Mk-probe', 'READ');",
  "      return 'returned';",
  "    } catch (error) {",
  "      return `threw ${(error as Error).message}`;",
  "    }",
  "  }),",
  "  grant: grantStream,",
  "  revoke: revoke({ notes }),",
  "  relay: relay({ grant: grantStream }),",
  "  };",
  "});",
].join("\n");

/** The result cell of a running `ACCESS_PATTERN`. */
type AccessPatternResult = Cell<{
  notes: string[];
  probe: string;
  grant: unknown;
  revoke: unknown;
  relay: unknown;
}>;

/** `payload` as an event the renderer marked as a trusted gesture. */
function gesture(payload: Record<string, unknown>): Record<string, unknown> {
  const event = {
    ...payload,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "MembersSurface",
        eventIntegrity: ["MembersSurface"],
        uiContractDataset: { uiAction: "ChangeAccess" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

/**
 * A loopback session factory recording the ids each commit it sends writes,
 * one list per commit, in the order they were sent. `beforeNextAclCommit`, when
 * set, runs once before the next commit that writes an access list is sent,
 * and a rejection from it takes the place of that commit's result.
 */
class RecordingSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly commits: string[][] = [];
  beforeNextAclCommit: (() => Promise<void>) | undefined;

  readonly #server: Server;

  constructor(server: Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    const transact = session.transact.bind(session);
    (session as { transact: typeof transact }).transact = async (
      commit,
      beforeIssue,
    ) => {
      const ids = commit.operations.flatMap((operation) =>
        "id" in operation ? [operation.id] : []
      );
      this.commits.push(ids);
      const before = this.beforeNextAclCommit;
      if (before !== undefined && ids.includes(`of:${space}`)) {
        this.beforeNextAclCommit = undefined;
        await before();
      }
      return await transact(commit, beforeIssue);
    };
    return { client, session };
  }
}

describe("space-access-change", () => {
  let server: Server;
  let cleanups: (() => Promise<void>)[];
  let serverCount = 0;

  beforeEach(() => {
    cleanups = [];
    server = new Server({
      store: new URL(`memory://space-access-change-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /**
   * Returns a client runtime acting as `user`, the factory recording what it
   * commits, and the errors its scheduler reports.
   */
  function clientRuntime(user: Identity): {
    runtime: Runtime;
    factory: RecordingSessionFactory;
    errors: string[];
  } {
    const factory = new RecordingSessionFactory(server);
    const storageManager = TestStorageManager.create(
      { as: user, memoryHost: new URL("memory://") },
      factory,
    );
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const errors: string[] = [];
    runtime.scheduler.onError((error: Error) => {
      errors.push(error.message);
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return { runtime, factory, errors };
  }

  /** Returns a serving runtime. */
  function servingRuntime(): Runtime {
    const storageManager = TestStorageManager.create(
      {
        as: alice,
        memoryHost: new URL("memory://"),
        servingHomeSpace: alice.did() as MemorySpace,
      },
      new RecordingSessionFactory(server),
    );
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      servingPosture: true,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  }

  /** Creates, through `runtime`, a space whose genesis list is `acl`. */
  async function createSpace(runtime: Runtime, acl: ACL): Promise<MemorySpace> {
    const space = await runtime.storageManager.createSpace!(acl);
    await syncAcl(runtime, space);
    return space;
  }

  /** Brings the access list of `space` into `runtime`'s replica. */
  async function syncAcl(runtime: Runtime, space: MemorySpace): Promise<void> {
    await runtime.getCellFromLink({
      space,
      id: `of:${space}` as URI,
      path: [],
    }).sync();
    await runtime.storageManager.synced();
  }

  /**
   * Replaces the access list of `space` with `acl` on the memory server,
   * writing as `writer` through a session of its own.
   */
  async function writeAclAs(
    writer: Identity,
    space: MemorySpace,
    acl: ACL,
  ): Promise<void> {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(server),
    });
    try {
      const session = await client.mount(
        space,
        {},
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: writer.did() },
        }),
      );
      await session.transact({
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${space}` as URI,
          value: { value: acl },
        }],
      });
    } finally {
      await client.close();
    }
  }

  /** Returns the access list the memory server holds for `space`. */
  async function storedAcl(space: MemorySpace): Promise<unknown> {
    return (await server.readDocument(space, `of:${space}`))?.value;
  }

  /** Returns how many of `factory`'s commits wrote the access list of `space`. */
  function aclCommitCount(
    factory: RecordingSessionFactory,
    space: MemorySpace,
  ): number {
    return factory.commits.filter((ids) => ids.includes(`of:${space}`)).length;
  }

  /** Compiles `ACCESS_PATTERN` and runs it in `space`, through `runtime`. */
  async function runAccessPattern(
    runtime: Runtime,
    space: MemorySpace,
  ): Promise<AccessPatternResult> {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: ACCESS_PATTERN }],
    }, { space });
    const argument = runtime.getCell<{ notes: string[] }>(
      space,
      "space-access-change argument",
      undefined,
    );
    const result = runtime.getCell(
      space,
      "space-access-change result",
      compiled.resultSchema,
    ) as unknown as AccessPatternResult;
    {
      const tx = runtime.edit();
      argument.withTx(tx).set({ notes: [] });
      expect((await tx.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancel = result.sink(() => {});
    cleanups.push(() => Promise.resolve(cancel()));
    await runtime.idle();
    return result;
  }

  /** Sends `event` to `result`'s stream `stream`, and waits for it to land. */
  async function send(
    runtime: Runtime,
    result: AccessPatternResult,
    stream: "grant" | "revoke" | "relay",
    event: Record<string, unknown>,
  ): Promise<void> {
    result.key(stream).send(event);
    await runtime.idle();
    await runtime.storageManager.synced();
  }

  /**
   * Calls `fn` in a handler frame over `tx`, whose event was a trusted gesture
   * unless `trustedGesture` is `false`, and returns the frame.
   */
  function inHandler(
    runtime: Runtime,
    tx: IExtendedStorageTransaction,
    fn: () => void,
    trustedGesture = true,
  ): Frame {
    const frame = pushFrame({
      runtime,
      tx,
      inHandler: true,
      frameKind: "handler",
      trustedGesture,
    });
    try {
      fn();
    } finally {
      popFrame(frame);
    }
    return frame;
  }

  describe("in a compiled pattern", () => {
    it("grants a level, which the memory server's list then holds, and commits the handler's writes", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);

      await send(runtime, result, "grant", gesture({ principal: bob.did() }));

      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      expect(result.key("notes").get()).toEqual([`granted ${bob.did()}`]);
    });

    it("commits the access list before the handler's own writes", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);
      const notesId = result.key("notes").resolveAsCell()
        .getAsNormalizedFullLink().id;
      const before = factory.commits.length;

      await send(runtime, result, "grant", gesture({ principal: bob.did() }));

      const sent = factory.commits.slice(before);
      const aclAt = sent.findIndex((ids) => ids.includes(`of:${space}`));
      const notesAt = sent.findIndex((ids) => ids.includes(notesId));
      expect(aclAt).toBeGreaterThanOrEqual(0);
      expect(sent[aclAt]).toEqual([`of:${space}`]);
      expect(notesAt).toBeGreaterThan(aclAt);
    });

    it("commits nothing to the list for a grant of the level already held", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const result = await runAccessPattern(runtime, space);
      const before = aclCommitCount(factory, space);

      await send(runtime, result, "grant", gesture({ principal: bob.did() }));

      expect(aclCommitCount(factory, space)).toBe(before);
      expect(result.key("notes").get()).toEqual([`granted ${bob.did()}`]);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
    });

    it("lowers a level", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "OWNER",
      });
      const result = await runAccessPattern(runtime, space);

      await send(
        runtime,
        result,
        "grant",
        gesture({ principal: bob.did(), level: "READ" }),
      );

      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "READ",
      });
    });

    it("revokes an entry", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
        [carol.did()]: "READ",
      });
      const result = await runAccessPattern(runtime, space);

      await send(runtime, result, "revoke", gesture({ principal: bob.did() }));

      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [carol.did()]: "READ",
      });
      expect(result.key("notes").get()).toEqual([`revoked ${bob.did()}`]);
    });

    it("commits nothing to the list for a revoke of an absent entry", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);
      const before = aclCommitCount(factory, space);

      await send(runtime, result, "revoke", gesture({ principal: bob.did() }));

      expect(aclCommitCount(factory, space)).toBe(before);
      expect(result.key("notes").get()).toEqual([`revoked ${bob.did()}`]);
    });

    it("changes neither the list nor the handler's data for an event that is not a trusted gesture", async () => {
      const { runtime, errors } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);

      await send(runtime, result, "grant", { principal: bob.did() });

      expect(errors.join("\n")).toContain("requires the handler's event");
      expect(await storedAcl(space)).toEqual({ [alice.did()]: "OWNER" });
      expect(result.key("notes").get()).toEqual([]);
    });

    it("changes nothing for a grant from a handler another handler passed a gesture on to", async () => {
      const { runtime, errors } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);

      await send(runtime, result, "relay", gesture({ principal: bob.did() }));

      expect(errors.join("\n")).toContain("requires the handler's event");
      expect(await storedAcl(space)).toEqual({ [alice.did()]: "OWNER" });
      expect(result.key("notes").get()).toEqual([]);
    });

    it("runs the handler again when the list changes under its commit, with the same gesture, and commits its writes once", async () => {
      const { runtime, factory, errors } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);
      const before = aclCommitCount(factory, space);
      factory.beforeNextAclCommit = () =>
        writeAclAs(alice, space, {
          [alice.did()]: "OWNER",
          [carol.did()]: "READ",
        });

      await send(runtime, result, "grant", gesture({ principal: bob.did() }));

      // The first commit conflicted with the concurrent write, and the second,
      // from the run the conflict started, is the one that landed.
      expect(aclCommitCount(factory, space)).toBe(before + 2);
      expect(errors).toEqual([]);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [carol.did()]: "READ",
        [bob.did()]: "WRITE",
      });
      expect(result.key("notes").get()).toEqual([`granted ${bob.did()}`]);
    });

    it("commits none of the handler's writes when the memory server refuses the change to the list", async () => {
      const { runtime, factory, errors } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);
      factory.beforeNextAclCommit = () =>
        Promise.reject(
          Object.assign(new Error("refused for the test"), {
            name: "AuthorizationError",
          }),
        );

      await send(runtime, result, "grant", gesture({ principal: bob.did() }));

      expect(errors.join("\n")).toContain(
        "The memory server refused the change to the access list",
      );
      expect(await storedAcl(space)).toEqual({ [alice.did()]: "OWNER" });
      expect(result.key("notes").get()).toEqual([]);
    });

    it("changes nothing for an actor without `OWNER`, whatever the payload names", async () => {
      // The payload names the space's owner everywhere an actor could
      // plausibly be read from, and the change is still refused as bob's.

      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { runtime, errors } = clientRuntime(bob);
      await syncAcl(runtime, space);
      const result = await runAccessPattern(runtime, space);

      await send(
        runtime,
        result,
        "grant",
        gesture({
          principal: carol.did(),
          acting: { user: alice.did(), session: "alice" },
          user: alice.did(),
          firedAt: { user: alice.did(), session: "alice" },
        }),
      );

      expect(errors.join("\n")).toContain(`which ${bob.did()} does not hold`);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      expect(result.key("notes").get()).toEqual([]);
    });

    it("lets a granted member reach the space, at the level `spaceAccess()` then returns", async () => {
      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
      });
      const result = await runAccessPattern(owner.runtime, space);
      const member = clientRuntime(bob);
      const levelOf = (): unknown => {
        const tx = member.runtime.edit();
        const frame = pushFrame({
          runtime: member.runtime,
          tx,
          frameKind: "handler",
          inHandler: true,
        });
        try {
          return spaceAccess(member.runtime.getCell(space, "reached"));
        } finally {
          popFrame(frame);
          tx.abort();
        }
      };
      await syncAcl(member.runtime, space);
      expect(levelOf()).toBe("none");

      await send(
        owner.runtime,
        result,
        "grant",
        gesture({ principal: bob.did(), level: "WRITE" }),
      );
      await syncAcl(member.runtime, space);

      expect(levelOf()).toBe("WRITE");
      const tx = member.runtime.edit();
      member.runtime.getCell<string>(space, "written by bob", undefined, tx)
        .set("hello");
      expect((await tx.commit()).error).toBeUndefined();
    });

    it("throws in a `computed()`", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const result = await runAccessPattern(runtime, space);

      expect(result.key("probe").get()).toContain(
        "threw `grantSpaceAccess()` is available only in a handler",
      );
    });
  });

  describe("grantSpaceAccess()", () => {
    /** Returns a client runtime acting as alice, and a space she owns. */
    async function owned(): Promise<{ runtime: Runtime; space: MemorySpace }> {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      return { runtime, space };
    }

    for (
      const [description, principal] of [
        ["`*`", "*"],
        ["a string that is not a DID", "bob"],
      ] as const
    ) {
      it(`throws for ${description} as the principal`, async () => {
        const { runtime, space } = await owned();
        const target = runtime.getCell(space, "target");
        expect(() =>
          inHandler(
            runtime,
            runtime.edit(),
            () => grantSpaceAccess(target, principal, "READ"),
          )
        ).toThrow("takes a principal's DID");
      });
    }

    it("throws for the space's own DID as the principal", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, space, "READ"),
        )
      ).toThrow("the entry of the space's own DID");
    });

    it("throws for the actor as the principal", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, alice.did(), "READ"),
        )
      ).toThrow("the entry of the principal it acts for");
    });

    it("throws for a target in the actor's own Home space", async () => {
      const { runtime } = await owned();
      const target = runtime.getCell(alice.did() as MemorySpace, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, bob.did(), "READ"),
        )
      ).toThrow("cannot change the access list of the Home space");
    });

    it("throws for a level that is not a grant level", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, bob.did(), "ADMIN"),
        )
      ).toThrow("takes a level of `READ`, `WRITE` or `OWNER`");
    });

    it("throws for a target that is not a cell", async () => {
      const { runtime } = await owned();
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess("did:key:z6Mk-not-a-cell", bob.did(), "READ"),
        )
      ).toThrow("takes a cell as its target");
    });

    it("throws for an event that is not a trusted gesture", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, bob.did(), "READ"),
          false,
        )
      ).toThrow("requires the handler's event to be a trusted gesture");
    });

    it("throws on a serving runtime", () => {
      const runtime = servingRuntime();
      const target = runtime.getCell(alice.did() as MemorySpace, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, bob.did(), "READ"),
        )
      ).toThrow("not available on a serving runtime");
    });

    it("throws in a `lift()` frame", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      const frame = pushFrame({
        runtime,
        tx: runtime.edit(),
        frameKind: "lift",
      });
      try {
        expect(() => grantSpaceAccess(target, bob.did(), "READ")).toThrow(
          "available only in a handler",
        );
      } finally {
        popFrame(frame);
      }
    });

    it("throws in a pattern body, even one built inside a handler", async () => {
      const { runtime, space } = await owned();
      const target = runtime.getCell(space, "target");
      const { pattern } = createTrustedBuilder(runtime).commonfabric;
      inHandler(runtime, runtime.edit(), () => {
        expect(() =>
          pattern(() => {
            grantSpaceAccess(target, bob.did(), "READ");
            return {};
          })
        ).toThrow("available only in a handler");
      });
    });

    it("throws for an actor the list this runtime holds gives no `OWNER`", async () => {
      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { runtime } = clientRuntime(bob);
      await syncAcl(runtime, space);
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, carol.did(), "READ"),
        )
      ).toThrow(`which ${bob.did()} does not hold`);
    });

    it("stages nothing for a grant of the level the list this runtime holds already gives", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "READ",
      });
      const target = runtime.getCell(space, "target");
      const frame = inHandler(
        runtime,
        runtime.edit(),
        () => grantSpaceAccess(target, bob.did(), "READ"),
      );
      expect(frame.pendingSpaceAccessChanges?.get(space)).toBeUndefined();

      // The same call with another level is what does stage a change.
      const control = inHandler(
        runtime,
        runtime.edit(),
        () => grantSpaceAccess(target, bob.did(), "WRITE"),
      );
      expect(control.pendingSpaceAccessChanges?.get(space)).toHaveLength(1);
    });

    it("throws for lowering the last concrete `OWNER`", async () => {
      // Bob holds `OWNER` through the `*` entry alone, so alice is the list's
      // only concrete `OWNER`.

      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        "*": "OWNER",
      });
      const { runtime } = clientRuntime(bob);
      await syncAcl(runtime, space);
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => grantSpaceAccess(target, alice.did(), "WRITE"),
        )
      ).toThrow("with no concrete `OWNER`");
    });
  });

  describe("revokeSpaceAccess()", () => {
    it("throws for the actor as the principal", async () => {
      const { runtime } = clientRuntime(alice);
      const space = await createSpace(runtime, { [alice.did()]: "OWNER" });
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => revokeSpaceAccess(target, alice.did()),
        )
      ).toThrow("the entry of the principal it acts for");
    });

    it("throws for a target in the actor's own Home space", async () => {
      const { runtime } = clientRuntime(alice);
      const target = runtime.getCell(alice.did() as MemorySpace, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => revokeSpaceAccess(target, bob.did()),
        )
      ).toThrow("cannot change the access list of the Home space");
    });

    it("throws for revoking the last concrete `OWNER`", async () => {
      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        "*": "OWNER",
      });
      const { runtime } = clientRuntime(bob);
      await syncAcl(runtime, space);
      const target = runtime.getCell(space, "target");
      expect(() =>
        inHandler(
          runtime,
          runtime.edit(),
          () => revokeSpaceAccess(target, alice.did()),
        )
      ).toThrow("with no concrete `OWNER`");
    });
  });

  describe("commitSpaceAccessChanges()", () => {
    it("throws, committing nothing, for an actor the list it replaces gives no `OWNER`, though staging could not tell", async () => {
      // Bob's runtime has not synced the list, so staging admits the change,
      // and the commit, which reads the list first, is where it is refused.

      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { runtime, factory } = clientRuntime(bob);
      const target = runtime.getCell(space, "target");
      const frame = inHandler(
        runtime,
        runtime.edit(),
        () => grantSpaceAccess(target, carol.did(), "OWNER"),
      );
      expect(frame.pendingSpaceAccessChanges?.get(space)).toHaveLength(1);

      await expect(commitSpaceAccessChanges(frame)).rejects.toThrow(
        `which ${bob.did()} does not hold`,
      );
      expect(aclCommitCount(factory, space)).toBe(0);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
    });

    it("commits nothing for a change the list it replaces already holds, though staging could not tell", async () => {
      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { runtime, factory } = clientRuntime(alice);
      const target = runtime.getCell(space, "target");
      const frame = inHandler(
        runtime,
        runtime.edit(),
        () => grantSpaceAccess(target, bob.did(), "WRITE"),
      );
      expect(frame.pendingSpaceAccessChanges?.get(space)).toHaveLength(1);
      const before = factory.commits.length;

      await commitSpaceAccessChanges(frame);

      expect(factory.commits.length).toBe(before);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
    });

    it("applies a handler's changes to one space in call order, as one commit", async () => {
      const { runtime, factory } = clientRuntime(alice);
      const space = await createSpace(runtime, {
        [alice.did()]: "OWNER",
        [carol.did()]: "READ",
      });
      const before = aclCommitCount(factory, space);
      const target = runtime.getCell(space, "target");
      const frame = inHandler(runtime, runtime.edit(), () => {
        grantSpaceAccess(target, bob.did(), "READ");
        grantSpaceAccess(target, bob.did(), "OWNER");
        revokeSpaceAccess(target, carol.did());
      });

      await commitSpaceAccessChanges(frame);

      expect(aclCommitCount(factory, space)).toBe(before + 1);
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "OWNER",
      });
    });
  });

  describe("the memory server", () => {
    it("keeps the list, and the change throws, for a principal without `OWNER`", async () => {
      // What the runtime's own checks stand in front of: a client that skips
      // them reaches this refusal.

      const owner = clientRuntime(alice);
      const space = await createSpace(owner.runtime, {
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
      const { runtime } = clientRuntime(bob);
      await syncAcl(runtime, space);

      await expect(new ACLManager(runtime, space).set(carol.did(), "OWNER"))
        .rejects.toThrow();
      expect(await storedAcl(space)).toEqual({
        [alice.did()]: "OWNER",
        [bob.did()]: "WRITE",
      });
    });
  });
});
