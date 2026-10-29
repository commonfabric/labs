import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { getLogger } from "@commonfabric/logger";

import { setCompileCacheRuntimeVersionForTesting } from "../src/compilation-cache/cell-cache.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const AUDIENCE = "did:key:z6Mk-runner-load-by-identity-read-only-audience";

/**
 * Opens each session on the one in-process server, as `signer`. A commit
 * into a space `failIn` names fails with the error it returns, before it
 * reaches the server.
 */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  failIn: ((space: MemorySpace) => Error | undefined) | undefined;
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
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
    session.transact = (...args: Parameters<typeof transact>) => {
      const failure = this.failIn?.(space);
      if (failure !== undefined) return Promise.reject(failure);
      return transact(...args);
    };
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const twice = lift((x: number) => x * 2);",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  return { result: twice(value) };",
      "});",
    ].join("\n"),
  }],
};

const logger = getLogger("pattern-manager");

/** How often `logger` has logged `key` at `level` since `counter` was called. */
const counter = (key: string, level: "debug" | "error") => {
  const read = () => logger.countsByKey[key]?.[level] ?? 0;
  const base = read();
  return () => read() - base;
};

/** How many lines `logger` has logged at error level, under any key, since `errorCounter` was called. */
const errorCounter = () => {
  const read = () =>
    Object.values(logger.countsByKey).reduce((n, { error }) => n + error, 0);
  const base = read();
  return () => read() - base;
};

describe("pattern-manager", () => {
  let server: MemoryV2Server.Server;
  let runtimes: Runtime[];

  const open = (identity: Identity) => {
    const factory = new LoopbackSessionFactory(server);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.overServer({ as: identity }, factory),
    });
    runtimes.push(runtime);
    return { runtime, factory };
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      store: new URL(
        `memory://load-by-identity-read-only-${crypto.randomUUID()}`,
      ),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await server.close();
  });

  /** A reader, and a space an owner holds that grants the reader `access`. */
  const readerOf = async (access: "READ" | "WRITE") => {
    const owner = await Identity.fromPassphrase("read-only copy owner");
    const reader = await Identity.fromPassphrase("read-only copy reader");
    const { runtime: ownerRuntime } = open(owner);
    const shared = await ownerRuntime.createSpace({
      grants: { [reader.did()]: access },
    });
    const { runtime, factory } = open(reader);
    return { runtime, factory, shared };
  };

  /**
   * As `readerOf`, where the reader's session compiled `PROGRAM` into its own
   * home. The session has written the closure into its home, so a load of the
   * program in the owner's space is served from memory.
   */
  const readerWithCompiledProgram = async (access: "READ" | "WRITE") => {
    const { runtime, factory, shared } = await readerOf(access);
    const home = await runtime.createSpace();
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space: home,
    });
    await runtime.patternManager.flushCompileCacheWrites();
    await runtime.storageManager.synced();
    const entry = runtime.patternManager.getArtifactEntryRef(compiled);
    if (entry === undefined) throw new Error("The program has no identity.");
    const load = () =>
      runtime.patternManager.loadPatternByIdentity(
        entry.identity,
        "default",
        shared,
      );
    return { runtime, factory, home, shared, compiled, load };
  };

  describe("a load served from memory, whose closure copy a space refuses", () => {
    it("copies nothing into a space the session may only read, and logs the refusal quietly, once", async () => {
      const reader = await readerWithCompiledProgram("READ");
      const errors = errorCounter();
      const refused = counter("closure-copy-refused", "debug");

      expect(await reader.load()).toBe(reader.compiled);
      await reader.runtime.patternManager.flushCompileCacheWrites();
      expect(await reader.load()).toBe(reader.compiled);
      await reader.runtime.patternManager.flushCompileCacheWrites();

      expect(refused()).toBe(1);
      expect(errors()).toBe(0);
    });

    it("logs a copy that fails for any other reason as a failed replication", async () => {
      const reader = await readerWithCompiledProgram("WRITE");
      reader.factory.failIn = (space) =>
        space === reader.shared
          ? new Error("The store is unavailable.")
          : undefined;
      const failed = counter("closure-replication-failed", "error");
      const writebackFailed = counter(
        "compile-cache-writeback-failed",
        "error",
      );
      const refused = counter("closure-copy-refused", "debug");

      expect(await reader.load()).toBe(reader.compiled);
      await reader.runtime.patternManager.flushCompileCacheWrites();

      expect(failed()).toBe(1);
      expect(writebackFailed()).toBe(1);
      expect(refused()).toBe(0);
    });

    it("logs a refused replication a caller asked for as one failed replication", async () => {
      // Only a copy a load issues on its own is expected to meet a space its
      // session may not write; a caller that names the space chose it.

      const reader = await readerWithCompiledProgram("READ");
      const errors = errorCounter();
      const failed = counter("closure-replication-failed", "error");
      const refused = counter("closure-copy-refused", "debug");

      reader.runtime.patternManager.replicatePatternToSpace(
        reader.compiled,
        reader.shared,
        reader.home,
      );
      await reader.runtime.patternManager.flushCompileCacheWrites();

      expect(failed()).toBe(1);
      expect(errors()).toBe(1);
      expect(refused()).toBe(0);
    });
  });

  describe("a compile into a space its session may only read", () => {
    // The write-back logs a refusal for want of a grant at debug and leaves
    // its caller to report it; a compile reports it by failing.

    const compileInto = async () => {
      const reader = await readerOf("READ");
      const errors = errorCounter();
      await expect(
        reader.runtime.patternManager.compilePattern(PROGRAM, {
          space: reader.shared,
        }),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
      return errors();
    };

    it("rejects with the space's refusal, and logs no error", async () => {
      expect(await compileInto()).toBe(0);
    });

    it("rejects with the space's refusal, and logs no error, when it caches source alone", async () => {
      // With no runtime version, a compile caches its source and no compiled
      // bytes, through the source write-back.

      const restore = setCompileCacheRuntimeVersionForTesting(undefined);
      try {
        expect(await compileInto()).toBe(0);
      } finally {
        restore();
      }
    });
  });
});
