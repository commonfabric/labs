import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { DID } from "@commonfabric/identity";
import { createSession, Identity } from "@commonfabric/identity";
import { EventEmitter } from "../../runtime-client/src/client/emitter.ts";
import {
  createRuntimeClientOptions,
  RuntimeInternals,
} from "../src/lib/runtime.ts";

const env = globalThis as typeof globalThis & {
  $API_URL?: string;
  $ENVIRONMENT?: string;
};
env.$API_URL ??= "http://shell.test/";
env.$ENVIRONMENT ??= "development";

type MockRuntimeClientEvents = {
  console: [unknown];
  navigaterequest: [{ cell: { id(): string; space(): DID } }];
  error: [unknown];
  telemetry: [unknown];
};

class MockRuntimeClient extends EventEmitter<MockRuntimeClientEvents> {
  idleCalls = 0;
  syncedCalls = 0;
  spaceRootPatternCalls = 0;
  registryWriteCalls = 0;
  slugByPieceId = new Map<string, string | undefined>();

  idle(): Promise<void> {
    this.idleCalls += 1;
    return Promise.resolve();
  }

  synced(): Promise<void> {
    this.syncedCalls += 1;
    return Promise.resolve();
  }

  getPieceSlug(pieceId: string): Promise<string | undefined> {
    return Promise.resolve(this.slugByPieceId.get(pieceId));
  }

  getSpaceRootPattern() {
    this.spaceRootPatternCalls += 1;
    return Promise.resolve({
      cell: () => ({
        key: () => ({
          send: () => {
            this.registryWriteCalls += 1;
            return Promise.resolve();
          },
        }),
        sync: () => Promise.resolve(),
      }),
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type NavigationDetail = {
  spaceDid: DID;
  pieceId: string;
};

describe("RuntimeInternals navigation", () => {
  it("exposes piece slug metadata", async () => {
    const spaceDid = "did:key:z6Mk-shell-runtime-did-nav" as DID;
    const client = new MockRuntimeClient();
    client.slugByPieceId.set("piece-789", "demo");
    const runtime = new (RuntimeInternals as any)(client);

    try {
      await expect(runtime.getSlug(spaceDid, "piece-789")).resolves.toBe(
        "demo",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("navigates after convergence without reading the space root", async () => {
    const env = globalThis as typeof globalThis & {
      $API_URL?: string;
      $ENVIRONMENT?: string;
      $COMMIT_SHA?: string;
      $MEMORY_VERSION?: string;
      $EXPERIMENTAL_MODERN_CELL_REP?: string;
    };
    const originalEnv = {
      $API_URL: env.$API_URL,
      $ENVIRONMENT: env.$ENVIRONMENT,
      $COMMIT_SHA: env.$COMMIT_SHA,
      $MEMORY_VERSION: env.$MEMORY_VERSION,
      $EXPERIMENTAL_MODERN_CELL_REP: env.$EXPERIMENTAL_MODERN_CELL_REP,
    };
    env.$API_URL = "http://shell.test/";
    env.$ENVIRONMENT = "development";
    env.$COMMIT_SHA = undefined;
    env.$MEMORY_VERSION = undefined;
    env.$EXPERIMENTAL_MODERN_CELL_REP = undefined;

    const nextSpace = "did:key:z6Mk-shell-runtime-did-nav-next" as DID;
    const client = new MockRuntimeClient();
    const runtime = new (RuntimeInternals as any)(client);

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
          id: () => "piece-456",
          space: () => nextSpace,
        },
      });

      await navigationReceived.promise;

      expect(client.idleCalls).toBe(1);
      expect(client.syncedCalls).toBe(1);
      expect(client.spaceRootPatternCalls).toBe(0);
      expect(client.registryWriteCalls).toBe(0);
      expect(navigation).toEqual({
        spaceDid: nextSpace,
        pieceId: "piece-456",
      });
    } finally {
      globalThis.removeEventListener("cf-navigate", onNavigate);
      env.$API_URL = originalEnv.$API_URL;
      env.$ENVIRONMENT = originalEnv.$ENVIRONMENT;
      env.$COMMIT_SHA = originalEnv.$COMMIT_SHA;
      env.$MEMORY_VERSION = originalEnv.$MEMORY_VERSION;
      env.$EXPERIMENTAL_MODERN_CELL_REP =
        originalEnv.$EXPERIMENTAL_MODERN_CELL_REP;
      await runtime.dispose();
    }
  });

  it("creates worker runtime options with explicit CFC enforcement and principal trust", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const session = createSession({ identity, spaceDid: identity.did() });

    const options = createRuntimeClientOptions({
      session,
      apiUrl: new URL("http://shell.test/"),
      // The rung the assertion below reads back, stated rather than left to
      // the host default.
      cfcEnforcementMode: "enforce-explicit",
    });

    expect(options.cfcEnforcementMode).toBe("enforce-explicit");
    expect(options.trustSnapshot).toEqual({
      id: `principal:${session.as.did()}`,
      actingPrincipal: session.as.did(),
    });
    expect(options.spaceDid).toBe(session.space);
  });
});
