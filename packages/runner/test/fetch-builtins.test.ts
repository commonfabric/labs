import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import { schemaWithOpenObjects } from "../src/builtins/fetch.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("test fetch builtins");
const space = signer.did();

const BINARY_BODY = new Uint8Array([0, 1, 2, 127, 253, 254, 255]);

describe("fetch builtins (fetchBinary / fetchText / fetchJson)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
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
    byRef = commonfabric.byRef;

    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

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
    await tx.commit();
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
    tx.commit();
    tx = runtime.edit();

    // Pull to trigger computation, then drain the in-flight transport frames
    // and post-commit fetch work.
    await result.pull();
    await clock.settle();

    return result.get() as { pending: any; result: any; error: any };
  }

  it("fetchText returns the response body as text", async () => {
    const data = await runFetch("fetchText", {
      url: "http://mock-test-server.local/text",
    }, "fetch-text-test");

    expect(data.error).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.result).toBe("hello fetch builtins");
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

  it("fetchJson surfaces schema verification failures on error", async () => {
    const data = await runFetch("fetchJson", {
      url: "http://mock-test-server.local/json",
      schema: {
        type: "object",
        properties: { missing: { type: "string" } },
        required: ["missing"],
      },
    }, "fetch-json-schema-fail-test");

    expect(data.result).toBeUndefined();
    expect(data.pending).toBe(false);
    expect(data.error).toBeDefined();
    expect(String(data.error?.message ?? data.error)).toContain(
      "failed schema validation",
    );
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

    expect((resultCell.get() as { result: unknown }).result).toBe(
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
    expect(cleared.result).toBeUndefined();
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
