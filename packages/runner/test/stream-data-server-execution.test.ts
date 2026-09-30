// Server-execution v2 stage A: the deferred `streamData` built-in is disabled
// under EXPERIMENTAL_SERVER_EXECUTION with a runtime error naming
// docs/specs/server-side-execution/builtins.md §5, and untouched with the
// flag off (the OFF arm is today's behavior byte-for-byte).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { defer } from "@commonfabric/utils/defer";

const signer = await Identity.fromPassphrase("test stream-data flag");
const space = signer.did();

describe("streamData under EXPERIMENTAL_SERVER_EXECUTION", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: string[];

  const boot = (serverExecution: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution },
    });
    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });
  };

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push(url);
      return Promise.resolve(
        new Response('id:1\nevent:message\ndata:{"value":true}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("flag on: the node errors, naming builtins.md §5, and nothing runs", async () => {
    boot(true);
    const firstError = defer<Error>();
    runtime.scheduler.onError((error) => firstError.resolve(error));

    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "stream-data-flag-on-test",
      undefined,
      tx,
    );
    // The stream is a computation: a reader has to demand it, and the
    // runtime's disposal ends the subscription.
    runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/stream",
    }, resultCell).sink(() => {});
    await tx.commit();

    const error = await firstError.promise;
    expect(String(error)).toContain(
      "docs/specs/server-side-execution/builtins.md §5",
    );
    expect(String(error)).toContain("EXPERIMENTAL_SERVER_EXECUTION");
    // Disabled means disabled: the stream never started.
    expect(fetchCalls).toEqual([]);
  });

  it("flag off: streamData behaves as today", async () => {
    boot(false);

    const streamData = byRef("streamData");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => streamData({ url }),
    );

    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      space,
      "stream-data-flag-off-test",
      undefined,
      tx,
    );
    // The stream is a computation: a reader has to demand it, and the
    // runtime's disposal ends the subscription.
    runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/stream",
    }, resultCell).sink(() => {});
    await tx.commit();
    await runtime.settled();

    expect(fetchCalls).toEqual(["http://mock-test-server.local/stream"]);
  });
});
