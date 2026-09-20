import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createBuilder } from "../src/builder/factory.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { setPatternEnvironment } from "../src/env.ts";

const signer = await Identity.fromPassphrase("test fetch mutex");
const space = signer.did();

describe("fetch-json mutex mechanism: reactive fetch state", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let computed: ReturnType<typeof createBuilder>["commonfabric"]["computed"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    computed = commonfabric.computed;
    byRef = commonfabric.byRef;

    // Set up pattern environment with a mock base URL
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    // Mock fetch
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      fetchCalls.push({ url, init });

      return Promise.resolve(
        new Response(
          JSON.stringify({ mocked: true, url }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    };
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should restart fetch when URL input changes", async () => {
    const urlCell = runtime.getCell<string>(space, "url-input", undefined, tx);
    urlCell.set("/api/first");
    tx.commit();
    tx = runtime.edit();

    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell = runtime.getCell(space, "url-change-test", undefined, tx);
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    // Pull first to trigger computation (starts the fetch), then drain the
    // in-flight transport frames and post-commit fetch work.
    await resultCell.pull();
    await clock.settle();

    const firstCallCount =
      fetchCalls.filter((c) => c.url.includes("/api/first")).length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Change the URL
    urlCell.withTx(tx).send("/api/second");
    tx.commit();
    tx = runtime.edit();

    // Pull first to trigger computation with new URL
    await resultCell.pull();
    await clock.settle();

    // Should have made a new fetch with the new URL
    const secondCallCount =
      fetchCalls.filter((c) => c.url.includes("/api/second")).length;
    expect(secondCallCount).toBeGreaterThan(0);
  });

  it("should handle switching between fetchJson and fetchText", async () => {
    const fetchJson = byRef("fetchJson");
    const fetchText = byRef("fetchText");

    // First fetch as JSON
    const jsonPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell1 = runtime.getCell(space, "mode-test-json", undefined, tx);
    runtime.run(tx, jsonPattern, { url: "/api/mode" }, resultCell1);
    tx.commit();

    // Pull first to trigger computation
    await resultCell1.pull();
    await clock.settle();

    const jsonCallCount = fetchCalls.length;
    expect(jsonCallCount).toBeGreaterThan(0);

    // Now fetch same URL as text - should trigger new fetch due to the
    // different builtin
    tx = runtime.edit();
    const textPattern = pattern<{ url: string }>(
      ({ url }) => fetchText({ url }),
    );

    const resultCell2 = runtime.getCell(space, "mode-test-text", undefined, tx);
    runtime.run(tx, textPattern, { url: "/api/mode" }, resultCell2);
    tx.commit();

    // Pull first to trigger computation
    await resultCell2.pull();
    await clock.settle();

    // Should have made additional fetch calls for the different builtin
    expect(fetchCalls.length).toBeGreaterThan(jsonCallCount);
  });

  it("should set pending to true during fetch and false after", async () => {
    // Use a longer delay to observe pending state
    const slowFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });

      return Promise.resolve(
        new Response(JSON.stringify({ mocked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };

    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell = runtime.getCell(space, "pending-test", undefined, tx);
    const result = runtime.run(
      tx,
      testPattern,
      { url: "/api/pending" },
      resultCell,
    );
    tx.commit();

    // Pull first to trigger computation (starts the fetch), then drain the
    // in-flight fetch work before reading the final state.
    await result.pull();
    await clock.settle();

    const finalData = (await result.pull()) as {
      pending?: boolean;
      result?: unknown;
    };

    // After completion, should have result
    expect(finalData.result).toBeDefined();
    expect(finalData.pending).toBe(false);

    // Restore original fetch
    globalThis.fetch = slowFetch;
  });

  const error404Fetch = () => {
    globalThis.fetch = () => {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    };
  };

  it("should handle fetch errors gracefully", async () => {
    error404Fetch();
    const sm = StorageManager.emulate({ as: signer });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    const localTx = rt.edit();
    const { commonfabric } = createTrustedBuilder(rt);
    const fetchJson = commonfabric.byRef("fetchJson");
    const testPattern = commonfabric.pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const resultCell = rt.getCell(
      space,
      "error-test-modern",
      undefined,
      localTx,
    );
    const result = rt.run(
      localTx,
      testPattern,
      { url: "/api/error" },
      resultCell,
    );
    localTx.commit();

    await result.pull();
    await clock.settle();

    const data = (await result.pull()) as {
      error?: unknown;
      pending?: boolean;
    };

    // The error reads back from the result cell with its `name`, `message`,
    // and `stack` intact.
    expect(data.error).toBeDefined();
    const fe = data.error as {
      name: string;
      message: string;
      stack: string;
    };
    expect(fe.name).toBe("Error");
    expect(fe.message).toMatch(/HTTP 404/);
    expect(typeof fe.stack).toBe("string");
    expect(data.pending).toBe(false);

    await localTx.commit();
    await rt.dispose();
    await sm.close();
  });

  it("should abort and clear state if URL becomes empty while waiting for mutex", async () => {
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchJson({ url }),
    );

    const urlCell = runtime.getCell<string>(
      space,
      "url-empty-test",
      undefined,
      tx,
    );
    urlCell.set("/api/test");

    const resultCell = runtime.getCell(space, "empty-url-test", undefined, tx);
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    // Change URL to empty
    urlCell.withTx(tx).send("");
    tx.commit();

    await clock.settle();

    const data = (await resultCell.pull()) as {
      error?: unknown;
      result?: unknown;
      pending?: boolean;
    };

    // Should have cleared state
    expect(data.result).toBeUndefined();
    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
  });

  it("includes computed options on the first fetch", async () => {
    const fetchJson = byRef("fetchJson");

    // Options come from a computed.
    const testRecipe = pattern<{ url: string }>(
      ({ url }) => {
        const options = computed(() => ({
          headers: { Accept: "application/vnd.github.v3.star+json" },
        }));
        return fetchJson({ url, options });
      },
    );

    const resultCell = runtime.getCell(
      space,
      "computed-options-test",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testRecipe,
      { url: "http://mock-test-server.local/api/stars" },
      resultCell,
    );
    tx.commit();

    // Pull and wait for the fetch to complete
    await result.pull();
    await clock.settle();

    // Filter to only the calls that hit our endpoint
    const relevantCalls = fetchCalls.filter((c) =>
      c.url.includes("/api/stars")
    );

    // The key assertion: every fetch call carries the computed headers, the
    // first included.
    expect(relevantCalls.length).toBeGreaterThan(0);
    for (const call of relevantCalls) {
      expect(call.init?.headers).toBeDefined();
      expect(
        (call.init?.headers as Record<string, string>)?.["Accept"],
      ).toBe("application/vnd.github.v3.star+json");
    }
  });
});
