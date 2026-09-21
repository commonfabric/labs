import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  CFC_ENFORCEMENT_MODES,
  cfcEnforcementStrictness,
  RUNTIME_CFC_DIAL_DEFAULTS,
} from "@commonfabric/runner/cfc";
import { createSession, Identity } from "@commonfabric/identity";
import type { DID } from "@commonfabric/identity";
import {
  createRuntimeClientOptions,
  defaultRenderConfidentialityCeiling,
  RuntimeInternals,
  type RuntimeTrustSnapshot,
} from "@commonfabric/lib-shell";
import {
  EventEmitter,
  type RuntimeTransport,
  TransportNotificationType,
} from "@commonfabric/runtime-client";

/** Fails to compile unless `Bound` satisfies `Declared`. */
type Satisfies<Bound extends Declared, Declared> = Bound;

// The audience a render ceiling admits is named by identity atoms over a
// DID, and the declared type of `actingPrincipal` is what holds a host to
// that. `@ts-expect-error` inverts the sense of the line it precedes: the
// type check fails when that line compiles. So a declaration that stopped
// rejecting a plain string would show up here rather than nowhere.
export type NonDidActingPrincipalIsRejected = Satisfies<
  // @ts-expect-error a trust snapshot's acting principal has to be a DID
  { id: "principal:loom-host"; actingPrincipal: "loom-host" },
  RuntimeTrustSnapshot
>;

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient {
  readonly signal: AbortSignal = new AbortController().signal;
  idleCalls = 0;
  syncedCalls = 0;
  slugByPieceId = new Map<string, string | undefined>();
  #handlers = new Map<
    keyof MockRuntimeClientEvents,
    Array<(...args: unknown[]) => void>
  >();

  on<K extends keyof MockRuntimeClientEvents>(
    event: K,
    handler: (...args: MockRuntimeClientEvents[K]) => void,
  ): void {
    const handlers = this.#handlers.get(event) ?? [];
    handlers.push(handler as (...args: unknown[]) => void);
    this.#handlers.set(event, handlers);
  }

  emit<K extends keyof MockRuntimeClientEvents>(
    event: K,
    ...args: MockRuntimeClientEvents[K]
  ): void {
    for (const handler of this.#handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  idle(): Promise<void> {
    this.idleCalls += 1;
    return Promise.resolve();
  }

  synced(): Promise<void> {
    this.syncedCalls += 1;
    return Promise.resolve();
  }

  resolvedSpaceNames: string[] = [];

  resolveSpaceName(name: string): Promise<DID> {
    this.resolvedSpaceNames.push(name);
    return Promise.resolve(`did:key:z6Mk-${name}` as DID);
  }

  /** Records the scope each slug read named, alongside the piece. */
  pieceSlugCalls: Array<{ pieceId: string; space: DID; scope?: string }> = [];

  getPieceSlug(
    pieceId: string,
    space: DID,
    scope?: string,
  ): Promise<string | undefined> {
    this.pieceSlugCalls.push({ pieceId, space, scope });
    return Promise.resolve(this.slugByPieceId.get(pieceId));
  }

  /** Records the piece each removal named, and the scope completing its id. */
  removePieceCalls: Array<{ pieceId: string; space: DID; scope?: string }> = [];

  removePiece(pieceId: string, space: DID, scope?: string): Promise<boolean> {
    this.removePieceCalls.push({ pieceId, space, scope });
    return Promise.resolve(true);
  }

  /**
   * Records the (pieceId, space) argument order source reads arrive in, and
   * the scope completing the id into a document address.
   */
  pieceSourceCalls: Array<{ pieceId: string; space: DID; scope?: string }> = [];

  getPieceSource(
    pieceId: string,
    space: DID,
    scope?: string,
  ): Promise<{ pieceId: string }> {
    this.pieceSourceCalls.push({ pieceId, space, scope });
    return Promise.resolve({ pieceId });
  }

  /** Records which space each root-pattern request targeted. */
  spaceRootCalls: DID[] = [];

  getSpaceRootPattern(space: DID): Promise<never> {
    this.spaceRootCalls.push(space);
    return Promise.reject(new Error("no root pattern in mock"));
  }

  /** Records every (pieceId, runIt, space) so tests can assert which calls
   * START the piece (CT-1623: name listings must not start every piece) and
   * which space each call targets. */
  getPieceCalls: Array<
    {
      pieceId: string;
      runIt: boolean | undefined;
      space: DID;
      scope?: string;
    }
  > = [];

  /** When set, the next `getPiece` rejects rather than answering. */
  failNextGetPiece = false;

  getPiece(
    pieceId: string,
    space: DID,
    runIt?: boolean,
    scope?: string,
  ): Promise<{ id: () => string }> {
    this.getPieceCalls.push({ pieceId, runIt, space, scope });
    if (this.failNextGetPiece) {
      this.failNextGetPiece = false;
      return Promise.reject(new Error("the socket went away"));
    }
    return Promise.resolve({ id: () => pieceId });
  }

  /**
   * Where the next `resolveSlug` lands. A test sets its space and scope to
   * say what the walk reached, that ref being the whole of what the caller
   * can check the reference against.
   */
  slugReference: {
    pieceId: string;
    pathAfter: string[];
    space: DID;
    scope: string;
  } | undefined = undefined;

  resolveSlugCalls: Array<
    { slug: string; space: DID; member: string | undefined }
  > = [];

  /** What the next `resolveSlug` refuses with, when it refuses. */
  slugRefusal: { code: string; message: string } | undefined = undefined;

  resolveSlug(
    slug: string,
    space: DID,
    member?: string,
  ): Promise<{
    piece?: { id(): string; cell(): { ref(): { space: DID; scope: string } } };
    pathAfter?: string[];
    refusal?: { code: string; message: string };
  }> {
    this.resolveSlugCalls.push({ slug, space, member });
    if (this.slugRefusal) {
      return Promise.resolve({ refusal: this.slugRefusal });
    }
    const reference = this.slugReference;
    if (!reference) return Promise.reject(new Error(`asking failed`));
    return Promise.resolve({
      piece: {
        id: () => reference.pieceId,
        cell: () => ({
          ref: () => ({ space: reference.space, scope: reference.scope }),
        }),
      },
      pathAfter: reference.pathAfter,
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type NavigationDetail = {
  spaceDid: DID;
  pieceId: string;
};

describe("RuntimeInternals", () => {
  /** Fails the test if anything reaches for a dedicated worker. */
  async function withNoWorkerConstructible<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
    (globalThis as { Worker: unknown }).Worker = class {
      constructor() {
        throw new Error("a supplied transport must spawn no worker");
      }
    };
    try {
      return await run();
    } finally {
      (globalThis as { Worker: unknown }).Worker = OriginalWorker;
    }
  }

  describe("createPiece", () => {
    it("forwards deterministic creation options and the explicit home space", async () => {
      const calls: unknown[] = [];
      const piece = { id: () => "participant-header" };
      const client = Object.assign(new MockRuntimeClient(), {
        createPiece: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(piece);
        },
      });
      const runtime = new RuntimeInternals(client as never);
      const space = "did:key:z6Mk-host-create-home" as DID;
      const source = new URL("https://fabric.example/header.tsx");
      const options = {
        cause: "host:participant-header:v1",
        argument: {},
        run: true,
      };
      try {
        expect(
          await runtime.createPiece(space, source, {
            cause: options.cause,
            argument: {},
            run: true,
          }),
        ).toBe(piece);
        expect(calls).toEqual([[source, space, options]]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("getSpaceRootPattern", () => {
    it("caches a successful root-pattern lookup", async () => {
      const client = new MockRuntimeClient();
      const rootPattern = { id: "root-pattern" };
      client.getSpaceRootPattern = (space: DID) => {
        client.spaceRootCalls.push(space);
        return Promise.resolve(rootPattern as never);
      };
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-cache" as DID;

      try {
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          rootPattern,
        );
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          rootPattern,
        );
        expect(client.spaceRootCalls).toEqual([space]);
      } finally {
        await runtime.dispose();
      }
    });

    it("starts the root for a caller that needs it running, after one that did not", async () => {
      const client = new MockRuntimeClient();
      const starts: Array<boolean | undefined> = [];
      client.getSpaceRootPattern = (
        space: DID,
        options?: { start?: boolean },
      ) => {
        client.spaceRootCalls.push(space);
        starts.push(options?.start);
        return Promise.resolve({ id: `root-${options?.start}` } as never);
      };
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-start" as DID;

      try {
        // A root resolved without starting cannot answer a caller that
        // renders it, so the cache must not hand the unstarted one back.
        await runtime.getSpaceRootPattern(space, { start: false });
        await runtime.getSpaceRootPattern(space);
        expect(starts).toEqual([false, true]);

        // The reverse direction shares: a started root already answers a
        // caller that only reads its exports.
        await runtime.getSpaceRootPattern(space, { start: false });
        expect(starts).toEqual([false, true]);
      } finally {
        await runtime.dispose();
      }
    });

    it("caches a recreated root as started", async () => {
      const client = new MockRuntimeClient();
      const recreated = { id: "recreated-root" };
      const starts: Array<boolean | undefined> = [];
      client.getSpaceRootPattern = (
        space: DID,
        options?: { start?: boolean },
      ) => {
        client.spaceRootCalls.push(space);
        starts.push(options?.start);
        return Promise.resolve({ id: "fetched-root" } as never);
      };
      (client as unknown as {
        recreateSpaceRootPattern: (space: DID) => Promise<unknown>;
      }).recreateSpaceRootPattern = () => Promise.resolve(recreated);
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-recreate" as DID;

      try {
        await runtime.getSpaceRootPattern(space, { start: false });
        expect(starts).toEqual([false]);

        // Recreating replaces whatever was cached, and what it caches IS
        // started — so neither kind of caller refetches afterwards.
        await expect(runtime.recreateSpaceRootPattern(space)).resolves.toBe(
          recreated,
        );
        await expect(runtime.getSpaceRootPattern(space)).resolves.toBe(
          recreated,
        );
        await expect(runtime.getSpaceRootPattern(space, { start: false }))
          .resolves.toBe(recreated);
        expect(starts).toEqual([false]);
      } finally {
        await runtime.dispose();
      }
    });

    it("retries a root-pattern lookup after rejection", async () => {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      const space = "did:key:z6Mk-root-retry" as DID;

      try {
        await expect(runtime.getSpaceRootPattern(space)).rejects.toThrow(
          "no root pattern in mock",
        );
        await expect(runtime.getSpaceRootPattern(space)).rejects.toThrow(
          "no root pattern in mock",
        );
        expect(client.spaceRootCalls).toEqual([space, space]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("reads a piece's source state through the client", async () => {
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);
    const space = "did:key:z6Mk-source-space" as DID;
    try {
      const source = await runtime.getPieceSource(space, "of:fid1:piece");

      expect(source).toEqual({ pieceId: "of:fid1:piece" });
      // The shell method takes (space, pieceId); the client takes them the
      // other way round, so the order is worth pinning.
      expect(client.pieceSourceCalls).toEqual([{
        pieceId: "of:fid1:piece",
        space,
        scope: undefined,
      }]);
    } finally {
      await runtime.dispose();
    }
  });

  it("carries a narrower scope through to every piece-addressed client call", async () => {
    // A piece reached through a link into a narrower scope is addressed by
    // its id and that scope together, so the facade has to be able to say
    // both — the id alone names a different document.

    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);
    const space = "did:key:z6Mk-scoped-space" as DID;
    try {
      await runtime.getPieceSource(space, "of:fid1:piece", "user");
      await runtime.getSlug(space, "of:fid1:piece", "user");
      await runtime.removePiece(space, "of:fid1:piece", "user");

      const addressed = {
        pieceId: "of:fid1:piece",
        space,
        scope: "user",
      };
      expect(client.pieceSourceCalls).toEqual([addressed]);
      expect(client.pieceSlugCalls).toEqual([addressed]);
      expect(client.removePieceCalls).toEqual([addressed]);
    } finally {
      await runtime.dispose();
    }
  });

  it("resolves named spaces through the worker client", async () => {
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);
    try {
      await expect(runtime.resolveSpaceName("notebook")).resolves.toBe(
        "did:key:z6Mk-notebook",
      );
      expect(client.resolvedSpaceNames).toEqual(["notebook"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("exposes piece slug metadata", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPieceId.set("piece-789", "demo");
    const runtime = new RuntimeInternals(client as any);

    try {
      await expect(runtime.getSlug(spaceDid, "piece-789")).resolves.toBe(
        "demo",
      );
    } finally {
      await runtime.dispose();
    }
  });

  describe("resolveSlug", () => {
    const space = "did:key:z6Mk-lib-shell-slug-reference" as DID;

    it("returns the piece a member reference reached", async () => {
      const client = new MockRuntimeClient();
      client.slugReference = {
        pieceId: "fid1:member-42",
        pathAfter: [],
        space,
        scope: "space",
      };
      const runtime = new RuntimeInternals(client as any);

      try {
        await expect(runtime.resolveSlug(space, "top", "42")).resolves.toEqual({
          pieceId: "fid1:member-42",
          scope: "space",
          pathAfter: [],
        });
        // The slug and the member cross as they were written, in the order
        // the client reads them.
        expect(client.resolveSlugCalls).toEqual([
          { slug: "top", space, member: "42" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("hands back a member the walk did not spend", async () => {
      const client = new MockRuntimeClient();
      // A slug naming a piece at its root spends nothing, so the member is
      // left over rather than silently becoming part of that piece's address.
      client.slugReference = {
        pieceId: "fid1:plain",
        pathAfter: ["42"],
        space,
        scope: "space",
      };
      const runtime = new RuntimeInternals(client as any);

      try {
        await expect(runtime.resolveSlug(space, "plain", "42")).resolves
          .toEqual({
            pieceId: "fid1:plain",
            scope: "space",
            pathAfter: ["42"],
          });
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses a piece in another space, in those terms", async () => {
      const client = new MockRuntimeClient();
      // Following a member's links can land outside the space the reference
      // was read in, and only the id crosses on to `getPattern`, which
      // re-derives the space from the view. Refusing here says so; letting it
      // through would report a piece that does not exist.
      client.slugReference = {
        pieceId: "fid1:elsewhere",
        pathAfter: [],
        space: "did:key:z6Mk-lib-shell-other-space" as DID,
        scope: "space",
      };
      const runtime = new RuntimeInternals(client as any);

      try {
        await expect(runtime.resolveSlug(space, "top", "42")).rejects.toThrow(
          "did:key:z6Mk-lib-shell-other-space",
        );
      } finally {
        await runtime.dispose();
      }
    });

    it("returns a piece in a narrower scope, carrying that scope", async () => {
      const client = new MockRuntimeClient();
      // A member reached through a user- or session-scoped link is a piece
      // like any other. Refusing it would turn a working address into a load
      // error; what it needs is its scope carried, because the id alone
      // addresses nothing.
      client.slugReference = {
        pieceId: "fid1:mine-only",
        pathAfter: [],
        space,
        scope: "user",
      };
      const runtime = new RuntimeInternals(client as any);

      try {
        await expect(runtime.resolveSlug(space, "top", "42")).resolves.toEqual({
          pieceId: "fid1:mine-only",
          scope: "user",
          pathAfter: [],
        });
      } finally {
        await runtime.dispose();
      }
    });

    it("returns a refusal rather than throwing one", async () => {
      const client = new MockRuntimeClient();
      client.slugRefusal = {
        code: "missing-member",
        message: "no member 999 in top",
      };
      const runtime = new RuntimeInternals(client as any);

      try {
        await expect(runtime.resolveSlug(space, "top", "999")).resolves
          .toEqual({
            refusal: {
              code: "missing-member",
              message: "no member 999 in top",
            },
          });
      } finally {
        await runtime.dispose();
      }
    });

    it("guards resolveSlug after dispose", async () => {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      await runtime.dispose();

      await expect(runtime.resolveSlug(space, "top", "42")).rejects.toThrow(
        "RuntimeInternals disposed.",
      );
    });
  });

  it("invalidates one piece without evicting another whose id ends the same", async () => {
    // `of:fid1:X` and `fid1:X` are both id spellings this tree handles, and
    // they are different pieces. Matching a flattened `<space>:<scope>:<id>`
    // key by its ends answers about one and evicts the other.
    const space = "did:key:z6Mk-lib-shell-invalidate" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    try {
      await runtime.getPattern(space, "fid1:XYZ");
      await runtime.getPattern(space, "of:fid1:XYZ");
      const before = client.getPieceCalls.length;

      runtime.invalidatePattern(space, "fid1:XYZ");

      // The one named is gone and reloads; the other is still cached and
      // answers without a second trip to the worker.
      await runtime.getPattern(space, "of:fid1:XYZ");
      expect(client.getPieceCalls.length).toBe(before);
      await runtime.getPattern(space, "fid1:XYZ");
      expect(client.getPieceCalls.length).toBe(before + 1);
    } finally {
      await runtime.dispose();
    }
  });

  it("caches one id in two scopes as two pieces", async () => {
    const space = "did:key:z6Mk-lib-shell-scope-cache" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    try {
      await runtime.getPattern(space, "fid1:XYZ", { scope: "space" });
      await runtime.getPattern(space, "fid1:XYZ", { scope: "user" });

      // Two documents, so two loads — a cache keyed on the id alone would
      // have handed the second caller the first one's piece.
      expect(client.getPieceCalls).toEqual([
        { pieceId: "fid1:XYZ", runIt: true, space, scope: "space" },
        { pieceId: "fid1:XYZ", runIt: true, space, scope: "user" },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves no empty levels behind when a load fails", async () => {
    // A nested cache holds a level per address component, so evicting only
    // the piece leaves the scope and the space it sat in — and a run of
    // failed lookups is a run of those, held for the runtime's lifetime.
    const space = "did:key:z6Mk-lib-shell-cache-levels" as DID;
    const client = new MockRuntimeClient();
    client.failNextGetPiece = true;
    const runtime = new RuntimeInternals(client as any);

    try {
      await expect(runtime.getPattern(space, "fid1:gone")).rejects.toThrow();
      expect(runtime.accessForTestingOnly.patternCacheSize).toBe(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("guards removePiece after dispose", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    const runtime = new RuntimeInternals(client as any);

    await runtime.dispose();

    await expect(runtime.removePiece(spaceDid, "piece-789")).rejects.toThrow(
      "RuntimeInternals disposed.",
    );
  });

  it("uses the default navigation event when no navigation callback is injected", async () => {
    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-nav-current" as DID;
    const client = new MockRuntimeClient();
    let registryWrites = 0;
    client.getSpaceRootPattern = (space: DID) => {
      client.spaceRootCalls.push(space);
      return Promise.resolve({
        cell: () => ({
          key: () => ({
            send: () => {
              registryWrites += 1;
              return Promise.resolve();
            },
          }),
          sync: () => Promise.resolve(),
        }),
      } as never);
    };
    const runtime = new RuntimeInternals(client as any);

    let navigation: NavigationDetail | undefined;
    const navigationReceived = deferred<NavigationDetail>();
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<typeof navigation>).detail;
      navigationReceived.resolve(navigation!);
    };
    globalThis.addEventListener("cf-navigate", onNavigate);

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-123",
          space: () => spaceDid,
        },
      });

      await navigationReceived.promise;
      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
      expect(navigation).toEqual({
        spaceDid,
        pieceId: "piece-123",
      });
      expect(client.spaceRootCalls).toEqual([]);
      expect(registryWrites).toBe(0);
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      await runtime.dispose();
    }
  });

  it("uses an injected navigation callback", async () => {
    const nextSpace = "did:key:z6Mk-lib-shell-runtime-next" as DID;
    const client = new MockRuntimeClient();
    const navigationReceived = deferred<NavigationDetail>();
    const runtime = new RuntimeInternals(
      client as any,
      {
        navigate: (navigation: unknown) => {
          navigationReceived.resolve(navigation as NavigationDetail);
        },
      },
    );

    try {
      client.emit("navigaterequest", {
        cell: {
          id: () => "piece-456",
          space: () => nextSpace,
        },
      });

      await expect(navigationReceived.promise).resolves.toEqual({
        spaceDid: nextSpace,
        pieceId: "piece-456",
      });
      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("logs a navigation-convergence failure without escaping as unhandled", async () => {
    const space = "did:key:z6Mk-lib-shell-nav-fail" as DID;
    const client = new MockRuntimeClient();
    client.synced = () => Promise.reject(new Error("convergence failed"));

    let navigated = false;
    const runtime = new RuntimeInternals(client as any, {
      navigate: () => {
        navigated = true;
      },
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      client.emit("navigaterequest", {
        cell: { id: () => "piece-fail", space: () => space },
      });
      // Let the fire-and-forget handler settle. An unhandled rejection here
      // would fail the test via Deno's sanitizer.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
      await runtime.dispose();
    }

    expect(navigated).toBe(false);
    expect(errors.length).toBe(1);
  });

  it("abandons navigation convergence silently when disposed mid-flight", async () => {
    const space = "did:key:z6Mk-lib-shell-nav-dispose" as DID;
    const client = new MockRuntimeClient();
    let rejectSynced!: (error: unknown) => void;
    const syncedGate = new Promise<void>((_, reject) => {
      rejectSynced = reject;
    });
    client.synced = () => syncedGate;

    let navigated = false;
    const runtime = new RuntimeInternals(client as any, {
      navigate: () => {
        navigated = true;
      },
    });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      client.emit("navigaterequest", {
        cell: { id: () => "piece-dispose", space: () => space },
      });
      // The handler is now parked on synced(); dispose, then cancel it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await runtime.dispose();
      rejectSynced(new DOMException("aborted", "AbortError"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.error = originalError;
    }

    expect(navigated).toBe(false);
    expect(errors.length).toBe(0);
  });

  it("defaults worker runtime options to shell-compatible CFC policy and principal trust", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-runtime-options",
    });

    const experimental = {
      modernCellRep: true,
    };
    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      experimental,
      // The two dials the assertions below read back, stated rather than
      // left to the host default.
      cfcEnforcementMode: "enforce-explicit",
      cfcRenderCeiling: false,
    });

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    // Epic H2: shell hosts run the flow-label dial at "persist" by default —
    // derived label components are written on every value write, activating
    // inv-9. H1 shipped "observe" (measurement); H2 flips to "persist" now that
    // re-derivation is idempotent (SC-11).
    expect(options.cfcFlowLabels).toBe("persist");
    expect(options.trustSnapshot).toEqual({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    });
    expect(options.spaceDid).toBe(session.space);
    expect(options.spaceName).toBe(session.spaceName);
    expect(options.experimental).toBe(experimental);
    // With the render ceiling off, neither ceiling field reaches the worker:
    // rendering is unbounded and author declassification is honored. The case
    // below reads the same two fields with the ceiling on.
    expect(options.renderDeclassificationPolicy).toBeUndefined();
    expect(options.renderConfidentialityCeiling).toBeUndefined();
  });

  it("defaults the CFC enforcement rung no lower than a runtime resolves on its own", async () => {
    // An embedder that states no dial gets the shell's default. A default
    // below the rung a Runtime resolves for a construction naming none would
    // hand that embedder less enforcement through the shell than without it.
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-enforcement-floor",
    });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
    });

    expect(
      CFC_ENFORCEMENT_MODES.filter((rung) =>
        cfcEnforcementStrictness(rung) >=
          cfcEnforcementStrictness(RUNTIME_CFC_DIAL_DEFAULTS.cfcEnforcementMode)
      ),
    ).toContain(options.cfcEnforcementMode);
  });

  it("populates the §8.10.6 render ceiling when cfcRenderCeiling is on", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-render-ceiling",
    });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: true,
    });

    // Author-supplied render-boundary declassification is denied under the
    // ceiling posture (audit S15) — a pattern cannot release a secret upward
    // through a render boundary.
    expect(options.renderDeclassificationPolicy).toBe("deny");
    expect(options.renderConfidentialityCeiling).toEqual(
      defaultRenderConfidentialityCeiling(session.as.did()),
    );
    // The profile names the acting user's audience through the §15.2
    // principal atom objects (User/PersonalSpace, resolved by the H3b render
    // resolver) plus the legacy DID-string form — every entry names exactly
    // this audience, admissible by construction (§8.10.6).
    expect(options.renderConfidentialityCeiling?.atoms).toContainEqual({
      type: "https://commonfabric.org/cfc/atom/User",
      subject: session.as.did(),
    });
    expect(options.renderConfidentialityCeiling?.atoms).toContainEqual({
      type: "https://commonfabric.org/cfc/atom/PersonalSpace",
      owner: session.as.did(),
    });
    expect(options.renderConfidentialityCeiling?.atoms).toContain(
      session.as.did(),
    );
    // Influence-class caveat kinds are display-dischargeable (rendered
    // disclosure); material-risk kinds (e.g. injection-risk-unscreened) are
    // deliberately NOT allow-listed.
    expect(options.renderConfidentialityCeiling?.caveatKinds).toContain(
      "https://commonfabric.org/cfc/concepts/prompt-influence",
    );
    expect(options.renderConfidentialityCeiling?.caveatKinds).not.toContain(
      "https://commonfabric.org/cfc/concepts/prompt-injection-risk-unscreened",
    );

    const off = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: false,
    });
    expect(off.renderDeclassificationPolicy).toBeUndefined();
    expect(off.renderConfidentialityCeiling).toBeUndefined();
  });

  it("builds the render ceiling for a host-supplied acting principal", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-render-ceiling-delegated",
    });
    const delegate = "did:key:z6MkDelegatedHost";

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      // Stated, not inherited from a host default: the subject here is
      // which principal the ceiling admits.
      cfcRenderCeiling: true,
      trustSnapshot: { id: `principal:${delegate}`, actingPrincipal: delegate },
    });

    // A display sink's audience is whoever the runtime renders as, which a
    // delegated host names in its own trust snapshot rather than in the
    // session identity.
    expect(options.renderConfidentialityCeiling).toEqual(
      defaultRenderConfidentialityCeiling(delegate),
    );
    expect(options.renderConfidentialityCeiling?.atoms).not.toContainEqual({
      type: "https://commonfabric.org/cfc/atom/User",
      subject: session.as.did(),
    });
  });

  it("falls back to the session identity when nobody is named", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-render-ceiling-fallback",
    });
    const sessionCeiling = defaultRenderConfidentialityCeiling(
      session.as.did(),
    );

    // `null` leaves the worker to build its default session-principal snapshot.
    // A supplied snapshot with no principal stays unnamed for transactions.
    // Both use the session identity as the render audience.
    const withoutSnapshot = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: true,
      trustSnapshot: null,
    });
    expect(withoutSnapshot.trustSnapshot).toBeUndefined();
    expect(withoutSnapshot.renderConfidentialityCeiling).toEqual(
      sessionCeiling,
    );

    const withoutPrincipal = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      cfcRenderCeiling: true,
      trustSnapshot: { id: "principal:loom-host" },
    });
    expect(withoutPrincipal.renderConfidentialityCeiling).toEqual(
      sessionCeiling,
    );
  });

  it("allows hosts to override CFC policy and trust snapshot", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-cfc-runtime-options",
    });
    const trustSnapshot: RuntimeTrustSnapshot = {
      id: "principal:loom-host",
      actingPrincipal: "did:key:z6MkLoomHost",
      revision: "loom-policy-v1",
    };

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      // The assertions below read `options.cfcEnforcementMode` and
      // `options.cfcFlowLabels` back as these values.
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "off",
      trustSnapshot,
    });

    expect(options.cfcEnforcementMode).toBe("observe");
    expect(options.cfcFlowLabels).toBe("off");
    expect(options.trustSnapshot).toBe(trustSnapshot);

    const withoutTrust = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      trustSnapshot: null,
    });
    expect(withoutTrust.trustSnapshot).toBeUndefined();
  });

  it("carries the worker-console flag onto the client options", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = await createSession({
      identity,
      spaceName: "lib-shell-forward-worker-console",
    });

    expect(
      createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://shell.test/"),
        forwardWorkerConsole: true,
      }).forwardWorkerConsole,
    ).toBe(true);
    expect(
      createRuntimeClientOptions({
        session,
        apiUrl: new URL("http://shell.test/"),
      }).forwardWorkerConsole,
    ).toBeUndefined();
  });

  describe("create() forwards host flags to the worker", () => {
    // create() builds the client options and sends the Initialize request; this
    // covers that path end to end and asserts the host flags reach the worker.
    // A stub worker completes the READY handshake, then fails Initialize so
    // create() aborts without a real runtime.

    type CapturedInitData = {
      forwardWorkerConsole?: boolean;
      concurrentWatchRefresh?: boolean;
      renderDeclassificationPolicy?: string;
      renderConfidentialityCeiling?: {
        atoms?: unknown[];
        caveatKinds?: string[];
      };
    };

    it("includes forwardWorkerConsole, concurrentWatchRefresh, and the render ceiling in the Initialize request", async () => {
      const identity = await Identity.generate({ implementation: "noble" });

      const initRequests: Array<{ data: CapturedInitData }> = [];
      class StubWorker extends EventTarget {
        constructor(_url: URL | string) {
          super();
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                // Encoded, as a real worker posts it: the transport decodes
                // every arriving envelope, so a raw object reads as damaged.
                data: realmFromFabricValue({
                  type: TransportNotificationType.WorkerReady,
                }),
              }),
            )
          );
        }
        postMessage(encoded: unknown): void {
          const message = fabricFromRealmValue(encoded as never);
          const msg = message as {
            msgId?: number;
            data?: { type?: string; data?: CapturedInitData };
          };
          if (typeof msg?.msgId !== "number") return;
          if (msg.data?.type === "initialize") {
            initRequests.push(msg.data as { data: CapturedInitData });
          }
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: realmFromFabricValue({
                  msgId: msg.msgId!,
                  error: "stub init failure",
                }),
              }),
            )
          );
        }
        terminate(): void {}
      }

      const OriginalWorker = (globalThis as { Worker: unknown }).Worker;
      (globalThis as { Worker: unknown }).Worker = StubWorker;
      try {
        await expect(
          RuntimeInternals.create({
            identity,
            apiUrl: new URL("http://shell.test/"),
            workerUrl: new URL("http://shell.test/scripts/worker-runtime.js"),
            getBuildHash: () => Promise.resolve(undefined),
            forwardWorkerConsole: true,
            concurrentWatchRefresh: true,
            cfcRenderCeiling: true,
          }),
        ).rejects.toThrow("stub init failure");
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
      }

      expect(initRequests).toHaveLength(1);
      expect(initRequests[0].data.forwardWorkerConsole).toBe(true);
      // The dogfood storage toggle rides the same InitializationData path; the
      // worker maps it into StorageManager.open's experimentalConcurrentWatchRefresh.
      expect(initRequests[0].data.concurrentWatchRefresh).toBe(true);
      // Epic H3a: the ceiling crosses the worker IPC as InitializationData —
      // exactly the fields the worker-side reconciler consumes.
      expect(initRequests[0].data.renderDeclassificationPolicy).toBe("deny");
      expect(initRequests[0].data.renderConfidentialityCeiling).toEqual(
        defaultRenderConfidentialityCeiling(identity.did()),
      );
    });
  });

  describe("worker URL versioning", () => {
    // A deployed page must keep its worker and lazy chunks on the same
    // immutable module graph. Local/legacy builds retain the root worker URL
    // and manifest cache-buster.

    async function workerUrlFromCreate(
      options: {
        getBuildHash: () => Promise<string | undefined>;
        clientVersion?: string;
        useDefaultWorkerUrl?: boolean;
      },
    ): Promise<URL> {
      const identity = await Identity.generate({ implementation: "noble" });

      const capturedUrls: string[] = [];
      class StubWorker extends EventTarget {
        constructor(url: URL | string) {
          super();
          capturedUrls.push(String(url));
          // Error out before READY so create() aborts right after the worker
          // URL is built — this test only covers URL construction, not the
          // worker protocol.
          queueMicrotask(() => {
            this.dispatchEvent(
              new ErrorEvent("error", { message: "stub worker" }),
            );
          });
        }
        postMessage(): void {}
        terminate(): void {}
      }

      const OriginalWorker = globalThis.Worker;
      const locationGlobal = globalThis as unknown as {
        location: URL | undefined;
      };
      const originalLocation = locationGlobal.location;
      (globalThis as { Worker: unknown }).Worker = StubWorker;
      locationGlobal.location = new URL("http://shell.test/");
      try {
        await expect(RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          ...(options.useDefaultWorkerUrl ? {} : {
            workerUrl: new URL(
              "http://shell.test/scripts/worker-runtime.js",
            ),
          }),
          clientVersion: options.clientVersion,
          getBuildHash: options.getBuildHash,
        })).rejects.toThrow("stub worker");
      } finally {
        (globalThis as { Worker: unknown }).Worker = OriginalWorker;
        locationGlobal.location = originalLocation;
      }
      expect(capturedUrls).toHaveLength(1);
      return new URL(capturedUrls[0]);
    }

    it("keeps a deployed worker in its immutable build namespace", async () => {
      let calls = 0;
      const url = await workerUrlFromCreate({
        clientVersion: "commit-123",
        useDefaultWorkerUrl: true,
        getBuildHash: () => {
          calls += 1;
          return Promise.resolve("newer-root-hash");
        },
      });
      expect(calls).toBe(0);
      expect(url.pathname).toBe(
        "/builds/commit-123/scripts/worker-runtime.js",
      );
      expect(url.search).toBe("");
      expect(new URL("./chunk-COMPILER.js", url).pathname).toBe(
        "/builds/commit-123/scripts/chunk-COMPILER.js",
      );
    });

    it("cache-busts the mutable root fallback", async () => {
      let calls = 0;
      const url = await workerUrlFromCreate({
        useDefaultWorkerUrl: true,
        getBuildHash: () => {
          calls += 1;
          return Promise.resolve("hash-123");
        },
      });
      expect(calls).toBe(1);
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.get("v")).toBe("hash-123");
    });

    it("keeps an explicit worker URL when the manifest has no hash", async () => {
      const url = await workerUrlFromCreate({
        getBuildHash: () => Promise.resolve(undefined),
      });
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.has("v")).toBe(false);
    });

    it("keeps an explicit local worker URL with a build identifier", async () => {
      const url = await workerUrlFromCreate({
        clientVersion: "source-checkout-sha",
        getBuildHash: () => Promise.resolve("local-worker-hash"),
      });
      expect(url.pathname).toBe("/scripts/worker-runtime.js");
      expect(url.searchParams.get("v")).toBe("local-worker-hash");
    });
  });

  describe("getPattern start semantics", () => {
    // CT-1623: starting a piece is expensive (pattern instantiation + eager
    // dependency collection in the worker). Read-only consumers like the header
    // pieces menu must be able to resolve piece handles WITHOUT starting, and a
    // non-started cache entry must not block a later display-path start.

    const spaceDid = "did:key:z6Mk-lib-shell-runtime-did-pattern" as DID;

    function makeRuntime() {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("starts by default (display path)", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: spaceDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("does not start when start: false (name listings)", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("upgrades a non-started cache entry when a starting caller asks", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid, scope: "space" },
          { pieceId: "piece-1", runIt: true, space: spaceDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves started entries from cache for both kinds of callers", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1");
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: spaceDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("serves repeated non-started requests from cache", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        await runtime.getPattern(spaceDid, "piece-1", { start: false });
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: false, space: spaceDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("lifetime signal", () => {
    it("exposes the client's lifetime signal", async () => {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      try {
        expect(runtime.signal).toBe(client.signal);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("getPattern multi-space", () => {
    // One runtime serves every space; a pattern's address is
    // (space, scope, id) and the cache is keyed by that whole address.

    const homeDid = "did:key:z6Mk-lib-shell-runtime-home" as DID;
    const otherDid = "did:key:z6Mk-lib-shell-runtime-other" as DID;

    function makeRuntime() {
      const client = new MockRuntimeClient();
      const runtime = new RuntimeInternals(client as any);
      return { client, runtime };
    }

    it("passes the space through to the client", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: otherDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("caches per address — one id in two spaces is two pieces", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: homeDid, scope: "space" },
          { pieceId: "piece-1", runIt: true, space: otherDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });

    it("invalidates per space", async () => {
      const { client, runtime } = makeRuntime();
      try {
        await runtime.getPattern(homeDid, "piece-1");
        await runtime.getPattern(otherDid, "piece-1");
        runtime.invalidatePattern(otherDid, "piece-1");
        await runtime.getPattern(homeDid, "piece-1"); // still cached
        await runtime.getPattern(otherDid, "piece-1"); // re-fetched
        expect(client.getPieceCalls).toEqual([
          { pieceId: "piece-1", runIt: true, space: homeDid, scope: "space" },
          { pieceId: "piece-1", runIt: true, space: otherDid, scope: "space" },
          { pieceId: "piece-1", runIt: true, space: otherDid, scope: "space" },
        ]);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe("an embedder-supplied transport", () => {
    // A shell page normally boots a dedicated worker of its own. A page whose
    // runtime is already running in another document's worker is handed a
    // connection instead, and `attach` is what says which of the two this
    // page is: the client that stands a runtime up, or one joining the
    // runtime already there.

    type SentRequest = { type: string; data?: Record<string, unknown> };

    /**
     * A transport that answers every request with a bare ack, recording what
     * was asked. It stands for a connection already made, which is what an
     * embedder supplies.
     */
    class StubTransport extends EventEmitter<{ message: [unknown] }> {
      readonly sent: SentRequest[] = [];
      disposals = 0;

      send(message: unknown): void {
        // A transport is handed the envelope itself; encoding it is the
        // business of the transports that cross a realm boundary.
        const envelope = message as { msgId?: number; data?: SentRequest };
        if (envelope.data) this.sent.push(envelope.data);
        if (typeof envelope.msgId !== "number") return;
        queueMicrotask(() => this.emit("message", { msgId: envelope.msgId }));
      }

      dispose(): Promise<void> {
        this.disposals += 1;
        return Promise.resolve();
      }
    }

    it("attaches over the supplied transport, spawning no worker", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const transport = new StubTransport();
      const runtime = await withNoWorkerConstructible(() =>
        RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          transport: transport as unknown as RuntimeTransport,
          attach: true,
          // The rung the attach frame carries, read back below.
          cfcEnforcementMode: "enforce-explicit",
        })
      );
      try {
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].type).toBe("attach");
        // The acting principal crosses as the DID it derives to. An attach
        // asserts which principal the runtime acts as; it supplies no signer.
        expect(transport.sent[0].data?.identity).toBe(identity.did());
        expect(transport.sent[0].data?.spaceDid).toBe(identity.did());
        expect(transport.sent[0].data?.cfcEnforcementMode).toBe(
          "enforce-explicit",
        );
        // The backend is posture, not routing: a document believing it reads
        // from somewhere else is as wrong about what it joined as one
        // believing another enforcement mode.
        expect(transport.sent[0].data?.apiUrl).toBe("http://shell.test/");
        // And no signer went with it. The initialize frame carries the key
        // pair; an attach carries a DID and nothing else of the identity.
        expect(transport.sent[0].data?.spaceIdentity).toBeUndefined();
        expect(typeof transport.sent[0].data?.identity).toBe("string");
      } finally {
        await runtime.dispose();
      }
    });

    it("refuses to attach with no transport to attach over", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      await expect(
        withNoWorkerConstructible(() =>
          RuntimeInternals.create({
            identity,
            apiUrl: new URL("http://shell.test/"),
            attach: true,
          })
        ),
      ).rejects.toThrow("`attach` needs a `transport`");
    });

    it("initializes over the supplied transport when not attaching", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const transport = new StubTransport();
      const runtime = await withNoWorkerConstructible(() =>
        RuntimeInternals.create({
          identity,
          apiUrl: new URL("http://shell.test/"),
          transport: transport as unknown as RuntimeTransport,
        })
      );
      try {
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0].type).toBe("initialize");
      } finally {
        await runtime.dispose();
      }
    });
  });
});
