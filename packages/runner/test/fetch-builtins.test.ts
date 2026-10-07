import {
  FabricUnavailable,
  UNAVAILABLE_PENDING,
  UNAVAILABLE_SYNCING,
  unavailableError,
} from "@commonfabric/data-model/availability";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { schemaWithOpenObjects } from "../src/builtins/fetch.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test fetch builtins");
const space = signer.did();
const remoteSpace = (await Identity.fromPassphrase(
  "test fetch builtins remote",
)).did();

const BINARY_BODY = new Uint8Array([0, 1, 2, 127, 253, 254, 255]);

async function rawResultChild(
  runtime: Runtime,
  container: any,
): Promise<unknown> {
  await runtime.storageManager.synced();
  const link = parseLink(container.key("result").getRaw(), container);
  if (!link) throw new Error("fetch result child link was not materialized");
  const tx = runtime.edit();
  try {
    return runtime.getCellFromLink(link, undefined, tx).getRaw();
  } finally {
    tx.abort();
  }
}

async function stateChild(
  runtime: Runtime,
  container: any,
  key: "pending" | "result" | "error",
) {
  await runtime.storageManager.synced();
  const link = parseLink(container.key(key).getRaw(), container);
  if (!link) throw new Error(`fetch ${key} child link was not materialized`);
  return runtime.getCellFromLink(link);
}

describe("fetch builtins (fetchBinary / fetchText / fetchJson)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let byRef: ReturnType<typeof createBuilder>["commonfabric"]["byRef"];
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let fetchStarted: PromiseWithResolvers<void>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    byRef = commonfabric.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    fetchStarted = Promise.withResolvers<void>();
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
      fetchStarted.resolve();

      if (url.endsWith("/text")) {
        return Promise.resolve(
          new Response("hello fetch builtins", {
            status: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
        );
      }
      if (url.endsWith("/binary")) {
        return Promise.resolve(
          new Response(BINARY_BODY.slice(), {
            status: 200,
            headers: { "Content-Type": "Image/PNG; some=param" },
          }),
        );
      }
      if (url.endsWith("/tuple")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: "a", extra: 1 }, 42]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ name: "widget", count: 3, extra: "ignored" }),
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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function runFetch(
    builtinRef: string,
    params: Record<string, unknown>,
    causeName: string,
  ): Promise<{ pending: any; result: any; error: any }> {
    const builtin = byRef(builtinRef);
    const testPattern = pattern<{ url: string }>(
      ({ url }) => builtin({ ...params, url }),
    );

    const resultCell = runtime.getCell(space, causeName, undefined, tx);
    const result = runtime.run(tx, testPattern, {
      url: params.url,
    }, resultCell);
    await tx.commit().settled;
    tx = runtime.edit();

    // Pull to trigger computation, then drain the in-flight transport frames
    // and post-commit fetch work.
    await result.pull();
    await clock.settle();
    await runtime.settled();
    await fetchStarted.promise;
    await waitForCellValue<boolean>(
      runtime,
      await stateChild(runtime, result, "pending"),
      (pending) => pending === false,
    );

    const state = result.get() as { pending: any; result: any; error: any };
    const rawResult = await rawResultChild(runtime, result);
    return { ...state, result: rawResult };
  }

  it("fetchText returns the response body as text", async () => {
    const data = await runFetch("fetchText", {
      url: "http://mock-test-server.local/text",
    }, "fetch-text-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toBe("hello fetch builtins");
  });

  it("upgrades persisted legacy fetch errors to direct error markers", async () => {
    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchText({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-legacy-error-upgrade",
      undefined,
      tx,
    );
    const state = runtime.run(tx, testPattern, {
      url: "http://mock-test-server.local/text",
    }, resultCell);
    await tx.commit().settled;
    tx = runtime.edit();

    await state.pull();
    await waitForCellValue<{ pending: boolean }>(
      runtime,
      state,
      (value) => value?.pending === false,
    );
    await state.pull();
    expect(await rawResultChild(runtime, state)).toBe("hello fetch builtins");
    expect(fetchCalls.length).toBe(1);

    const pending = await stateChild(runtime, state, "pending");
    const result = await stateChild(runtime, state, "result");
    const error = await stateChild(runtime, state, "error");
    pending.withTx(tx).set(false);
    result.withTx(tx).setRawUntyped(undefined);
    error.withTx(tx).set(new Error("persisted legacy failure"));
    await tx.commit().settled;
    tx = runtime.edit();

    await state.pull();
    await runtime.settled();
    await state.pull();

    const upgraded = await rawResultChild(runtime, state) as FabricUnavailable;
    expect(upgraded).toBeInstanceOf(FabricUnavailable);
    expect(upgraded.reason).toBe("error");
    expect(upgraded.errorMessage).toBe("persisted legacy failure");
    expect(fetchCalls.length).toBe(1);
  });

  it("fetchJson returns the parsed response body", async () => {
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
    }, "fetch-json-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toEqual({
      name: "widget",
      count: 3,
      extra: "ignored",
    });
  });

  it("does not treat fetchJson's result type hint as an unavailable input", async () => {
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
      result: UNAVAILABLE_PENDING,
    }, "fetch-json-unavailable-result-hint-test");

    expect(data.result).toEqual({
      name: "widget",
      count: 3,
      extra: "ignored",
    });
    expect(data.pending).toBe(false);
    expect(fetchCalls.length).toBe(1);
  });

  it("fetchJson verifies the response against a schema at fetch time", async () => {
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "number" } },
        required: ["name", "count"],
      },
    }, "fetch-json-schema-ok-test");

    // The response has a property the schema doesn't name (`extra`);
    // verification follows standard JSON Schema semantics and allows it.
    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toEqual({
      name: "widget",
      count: 3,
      extra: "ignored",
    });
  });

  it("fetchJson classifies response schema verification failures", async () => {
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
      schema: {
        type: "object",
        properties: { missing: { type: "string" } },
        required: ["missing"],
      },
    }, "fetch-json-schema-fail-test");

    expect(data.result).toMatchObject({
      reason: "error",
      errorKind: "schemaMismatch",
    });
    expect(data.pending).toBe(false);
    expect(data.error).toBeDefined();
    expect((data.result as FabricUnavailable).errorMessage).toContain(
      "failed schema validation",
    );
    expect(String(data.error?.message ?? data.error)).toContain(
      "failed schema validation",
    );
  });

  it("publishes pending in the input-change transition without stale success", async () => {
    const urlCell = runtime.getCell<string>(
      space,
      "fetch-transition-url",
      undefined,
      tx,
    );
    urlCell.set("http://mock-test-server.local/text");

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchText({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-transition-result",
      undefined,
      tx,
    );
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await resultCell.pull();
    await runtime.settled();
    await resultCell.pull();
    expect(await rawResultChild(runtime, resultCell)).toBe(
      "hello fetch builtins",
    );

    const secondResponse = Promise.withResolvers<Response>();
    const secondStarted = Promise.withResolvers<void>();
    globalThis.fetch = async () => {
      secondStarted.resolve();
      return await secondResponse.promise;
    };

    urlCell.withTx(tx).send("http://mock-test-server.local/second-text");
    tx.commit();
    tx = runtime.edit();

    await resultCell.pull();
    await secondStarted.promise;

    const transitioning = resultCell.get() as {
      pending: boolean;
      result: unknown;
      error: unknown;
    };
    expect(await rawResultChild(runtime, resultCell)).toBe(
      UNAVAILABLE_PENDING,
    );
    expect(transitioning.pending).toBe(true);
    expect(transitioning.error).toBeUndefined();

    secondResponse.resolve(new Response("new response", { status: 200 }));
    await runtime.settled();
    await resultCell.pull();
    expect(await rawResultChild(runtime, resultCell)).toBe(
      "new response",
    );
  });

  it("does not launch a claimed fetch after its input becomes unavailable", async () => {
    const urlCell = runtime.getCell<string | FabricUnavailable>(
      space,
      "fetch-claim-handoff-url",
      undefined,
      tx,
    );
    urlCell.set("http://mock-test-server.local/claimed-text");

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchText({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-claim-handoff-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
    const claimed = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    let editCalls = 0;
    runtime.editWithRetry = async (...args) => {
      const value = await originalEditWithRetry(...args);
      if (++editCalls === 1) {
        claimed.resolve();
        await releaseClaim.promise;
      }
      return value;
    };

    try {
      const initialPull = result.pull();
      await claimed.promise;

      urlCell.withTx(tx).setRaw(UNAVAILABLE_SYNCING);
      tx.commit();
      tx = runtime.edit();
      await result.pull();

      expect(await rawResultChild(runtime, result)).toBe(
        UNAVAILABLE_SYNCING,
      );
      expect(fetchCalls).toEqual([]);

      releaseClaim.resolve();
      await initialPull;
      await runtime.settled();
      await runtime.idle();

      expect(fetchCalls).toEqual([]);
      expect(await rawResultChild(runtime, result)).toBe(
        UNAVAILABLE_SYNCING,
      );
    } finally {
      releaseClaim.resolve();
      runtime.editWithRetry = originalEditWithRetry;
    }
  });

  it("does not publish stale success when unavailable input hashes like the prior body", async () => {
    const bodyCell = runtime.getCell<unknown>(
      space,
      "fetch-stale-body",
      undefined,
      tx,
    );
    bodyCell.set({});

    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    globalThis.fetch = () => {
      started.resolve();
      // Deliberately ignore AbortSignal to exercise the writeback CAS.
      return response.promise;
    };

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ body: unknown }>(
      ({ body }) =>
        fetchText({
          url: "http://mock-test-server.local/stale-body",
          options: { method: "POST", body },
        }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-stale-body-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { body: bodyCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    await started.promise;

    await runtime.storageManager.synced();
    const childLink = parseLink(result.key("result").getRaw(), result);
    if (!childLink) throw new Error("fetch result child was not materialized");
    const resultChild = runtime.getCellFromLink(childLink);
    await resultChild.sync();
    const observed: unknown[] = [];
    const cancelSink = resultChild.sink(() => {
      observed.push(resultChild.getRaw());
    });

    try {
      bodyCell.withTx(tx).setRaw(UNAVAILABLE_PENDING);
      tx.commit();
      tx = runtime.edit();
      await result.pull();
      expect(await rawResultChild(runtime, result)).toBe(
        UNAVAILABLE_PENDING,
      );

      response.resolve(new Response("stale-success", { status: 200 }));
      await runtime.settled();
      await runtime.idle();

      expect(observed).not.toContain("stale-success");
      expect(await rawResultChild(runtime, result)).toBe(
        UNAVAILABLE_PENDING,
      );
    } finally {
      response.resolve(new Response("released", { status: 200 }));
      cancelSink();
    }
  });

  it("propagates unavailable raw inputs without performing a fetch", async () => {
    const marker = UNAVAILABLE_SYNCING;
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchJson({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-unavailable-input-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url: marker }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const state = result.get() as {
      pending: boolean;
      result: unknown;
      error: unknown;
    };
    const propagated = await rawResultChild(
      runtime,
      result,
    ) as FabricUnavailable;
    expect(propagated).toBeInstanceOf(FabricUnavailable);
    expect(propagated.reason).toBe("syncing");
    expect(state.pending).toBe(false);
    expect(state.error).toBeUndefined();
    expect(fetchCalls).toEqual([]);
  });

  it("reacts when an unavailable root input becomes usable", async () => {
    const url = runtime.getCell<string | FabricUnavailable>(
      space,
      "fetch-unavailable-then-usable-url",
      undefined,
      tx,
    );
    url.setRaw(UNAVAILABLE_PENDING);
    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchText({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-unavailable-then-usable-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, { url }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();
    expect(await rawResultChild(runtime, result)).toBe(
      UNAVAILABLE_PENDING,
    );
    expect(fetchCalls).toEqual([]);

    url.withTx(tx).setRaw("http://mock-test-server.local/text");
    tx.commit();
    tx = runtime.edit();
    await result.pull();
    await runtime.settled();
    await result.pull();

    expect(await rawResultChild(runtime, result)).toBe(
      "hello fetch builtins",
    );
    expect(fetchCalls.length).toBe(1);
  });

  it("propagates an unavailable value through a linked input", async () => {
    const upstream = runtime.getCell(
      space,
      "fetch-unavailable-upstream",
      undefined,
      tx,
    );
    upstream.setRaw(unavailableError(new Error("upstream failed")));

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchText({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-linked-unavailable-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: upstream },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const unavailable = await rawResultChild(
      runtime,
      result,
    ) as FabricUnavailable;
    expect(unavailable).toBeInstanceOf(FabricUnavailable);
    expect(unavailable.reason).toBe("error");
    expect(unavailable.errorMessage).toBe("upstream failed");
    expect(fetchCalls).toEqual([]);
  });

  it("resolves nested relative links from their actual input position", async () => {
    const holder = runtime.getCell(
      space,
      "fetch-nested-relative-holder",
      undefined,
      tx,
    );
    const bodyLink = holder.key("payload").getAsLink({
      base: holder.key("options", "body"),
    });
    holder.setRaw({
      payload: UNAVAILABLE_PENDING,
      options: { body: bodyLink },
    });

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ options: unknown }>(
      ({ options }) =>
        fetchText({
          url: "http://mock-test-server.local/should-not-run",
          options,
        }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-nested-relative-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, testPattern, {
      options: holder.key("options"),
    }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(await rawResultChild(runtime, result)).toBe(
      UNAVAILABLE_PENDING,
    );
    expect(fetchCalls).toEqual([]);
  });

  it("settles an absent cross-space URL as invalid input", async () => {
    const missingRemote = runtime.getCell(
      remoteSpace,
      "fetch-missing-remote-url",
    );
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchJson({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-missing-remote-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: missingRemote.getAsLink() },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    const unavailable = await rawResultChild(
      runtime,
      result,
    ) as FabricUnavailable;
    expect(unavailable).toBeInstanceOf(FabricUnavailable);
    expect(unavailable.reason).toBe("error");
    expect(unavailable.errorKind).toBe("invalidInput");
    expect(fetchCalls).toEqual([]);
  });

  it("classifies a locally complete missing URL as invalid input", async () => {
    const missingLocal = runtime.getCell(
      space,
      "fetch-missing-local-url",
    );
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: unknown }>(
      ({ url }) => fetchJson({ url }),
    );
    const resultCell = runtime.getCell(
      space,
      "fetch-missing-local-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      { url: missingLocal.getAsLink() },
      resultCell,
    );
    tx.commit();
    tx = runtime.edit();

    await result.pull();

    expect(await rawResultChild(runtime, result)).toMatchObject({
      reason: "error",
      errorKind: "invalidInput",
    });
    expect(fetchCalls).toEqual([]);
  });

  it("fetchBinary returns a FabricBytes buffer and the media type", async () => {
    const data = await runFetch("fetchBinary", {
      url: "http://mock-test-server.local/binary",
    }, "fetch-binary-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result.mediaType).toBe("image/png");
    // The bytes read back from the cell as a FabricBytes; slice() returns the
    // original buffer.
    expect(data.result.bytes.length).toBe(BINARY_BODY.length);
    expect(Array.from(data.result.bytes.slice())).toEqual(
      Array.from(BINARY_BODY),
    );
  });

  it("fetchJsonUnchecked parses without verification", async () => {
    const data = await runFetch("fetchJsonUnchecked", {
      url: "http://mock-test-server.local/json",
    }, "fetch-json-unchecked-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toEqual({
      name: "widget",
      count: 3,
      extra: "ignored",
    });
  });

  it("fetchJson opens every nested object in a deep schema", async () => {
    // Verification walks the whole schema opening object subschemas (so unknown
    // properties are allowed). This schema reaches each recursion branch:
    // nested properties, $defs, array `items` in both object and tuple form,
    // `not`, an object-valued `additionalProperties`, and `anyOf` with a
    // boolean member. The response only needs the one required field.
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          nested: {
            type: "object",
            properties: { inner: { type: "number" } },
          },
          list: {
            type: "array",
            items: { type: "object", properties: { y: { type: "string" } } },
          },
          tuple: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
          choice: { anyOf: [{ type: "object" }, true] },
          none: { not: { type: "string" } },
          bag: { additionalProperties: { type: "string" } },
        },
        $defs: {
          Def: { type: "object", properties: { z: { type: "number" } } },
        },
        required: ["name"],
      },
    }, "fetch-json-deep-schema-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toEqual({
      name: "widget",
      count: 3,
      extra: "ignored",
    });
  });

  it("fetchJson accepts a tuple (prefixItems) result schema", async () => {
    // Tuple slots are not validated on this path today: `prefixItems` sits in
    // the strict-constraints tier and fetch verification runs non-strict. This
    // pins that a tuple result schema doesn't reject the fetch outright; the
    // open-objects rewrite of tuple slots is pinned by the
    // schemaWithOpenObjects unit tests below.
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/tuple",
      schema: {
        type: "array",
        prefixItems: [
          { type: "object", properties: { id: { type: "string" } } },
          { type: "number" },
        ],
      },
    }, "fetch-json-tuple-schema-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toEqual([{ id: "a", extra: 1 }, 42]);
  });

  it("clears a prior result when the URL becomes empty", async () => {
    const urlCell = runtime.getCell<string>(
      space,
      "fetch-clear-url-input",
      undefined,
      tx,
    );
    urlCell.set("http://mock-test-server.local/text");
    tx.commit();
    tx = runtime.edit();

    const fetchText = byRef("fetchText");
    const testPattern = pattern<{ url: string }>(
      ({ url }) => fetchText({ url }),
    );

    const resultCell = runtime.getCell(
      space,
      "fetch-clear-result",
      undefined,
      tx,
    );
    runtime.run(tx, testPattern, { url: urlCell }, resultCell);
    tx.commit();
    tx = runtime.edit();

    await resultCell.pull();
    await clock.settle();

    expect(await rawResultChild(runtime, resultCell)).toBe(
      "hello fetch builtins",
    );

    // Emptying the URL drives the action down the no-URL branch, which clears
    // the previously-set pending/result/error/internal cells.
    urlCell.withTx(tx).send("");
    tx.commit();
    tx = runtime.edit();

    await resultCell.pull();
    await clock.settle();

    const cleared = resultCell.get() as {
      pending: boolean;
      result: unknown;
      error: unknown;
    };
    expect(await rawResultChild(runtime, resultCell)).toMatchObject({
      reason: "error",
      errorKind: "invalidInput",
    });
    expect(cleared.pending).toBe(false);
    expect(cleared.error).toBeUndefined();
  });
});

describe("schemaWithOpenObjects", () => {
  it("opens object schemas inside `prefixItems` slots", () => {
    const opened = schemaWithOpenObjects({
      type: "array",
      prefixItems: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "number" },
      ],
    }) as Record<string, any>;

    expect(opened.prefixItems[0].additionalProperties).toBe(true);
    expect(opened.prefixItems[1].additionalProperties).toBeUndefined();
  });

  it("leaves never-emitted keywords untouched", () => {
    // `contains`/`if`/`then`/`else` are in schema-walk's unused tier — our
    // schemas never emit them, and rewriting them here would make those paths
    // look supported. If one becomes emitted it moves to the used tier and
    // this walk picks it up.
    const opened = schemaWithOpenObjects({
      type: "array",
      contains: { type: "object", properties: { x: { type: "number" } } },
      if: { type: "object", properties: { kind: { const: "a" } } },
      then: { type: "object", properties: { a: { type: "string" } } },
    } as JSONSchema) as Record<string, any>;

    expect(opened.contains.additionalProperties).toBeUndefined();
    expect(opened.if.additionalProperties).toBeUndefined();
    expect(opened.then.additionalProperties).toBeUndefined();
  });

  it("still opens nested objects and leaves non-object shapes alone", () => {
    const opened = schemaWithOpenObjects({
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "object", properties: { y: { type: "string" } } },
        },
      },
      $defs: {
        Def: { type: "object", properties: { z: { type: "number" } } },
      },
    }) as Record<string, any>;

    expect(opened.additionalProperties).toBe(true);
    expect(opened.properties.list.additionalProperties).toBeUndefined();
    expect(opened.properties.list.items.additionalProperties).toBe(true);
    expect(opened.$defs.Def.additionalProperties).toBe(true);
  });
});
