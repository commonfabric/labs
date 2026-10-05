import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PropertyValues } from "lit";

import {
  $conn,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import type { FabricBridge } from "@commonfabric/iframe-sandbox";

import { CFIframe } from "./index.ts";

type CFIframeInternals = {
  onRuntime(runtime: RuntimeClient | undefined): void;
  onLoad(): void;
  onError(event: CustomEvent): void;
  dismissError(): void;
  fixError(): void;
  willUpdate(changed: PropertyValues<CFIframe>): void;
};

const internals = (element: CFIframe): CFIframeInternals =>
  element as unknown as CFIframeInternals;

const contextChange = (): PropertyValues<CFIframe> =>
  new Map([["context", null]]) as PropertyValues<CFIframe>;

const templateValues = (element: CFIframe): readonly unknown[] =>
  element.render().values;

describe("CFIframe", () => {
  it("constructs with an empty bridge and source", () => {
    const element = new CFIframe();

    expect(element.src).toBe("");
    expect(element.context).toBeNull();
    expect(element.bridge).toBeNull();
    expect(element.resourceKinds).toBeNull();
    internals(element).willUpdate(contextChange());
    expect(templateValues(element).slice(0, 2)).toEqual([
      { resources: {} },
      "",
    ]);
  });

  it("uses a plain context as local cell resources", () => {
    const element = new CFIframe();
    const context = { count: 1 };
    element.src = "<p>ready</p>";
    element.context = context;

    internals(element).willUpdate(contextChange());

    const [bridge, source] = templateValues(element) as [
      FabricBridge,
      string,
    ];
    expect(source).toBe("<p>ready</p>");
    expect(bridge.resources.count.cell!.get()).toBe(1);
  });

  it("keeps a cell-backed source closed until its resources resolve", async () => {
    const ref: CellRef = {
      id: "of:context" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object", properties: {} },
    };
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) =>
          request.type === RequestType.CellResolveAsCell
            ? Promise.resolve({
              cell: { ...ref, id: "of:resolved" as CellRef["id"] },
            })
            : Promise.resolve({ value: {} }),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const element = new CFIframe();
    element.src = "<p>ready</p>";
    element.context = new CellHandle(runtime, ref);
    const updated = Promise.withResolvers<void>();
    element.requestUpdate = () => updated.resolve();

    internals(element).willUpdate(contextChange());

    expect(templateValues(element)[1]).toBe("");
    await updated.promise;
    expect(templateValues(element)[1]).toBe("<p>ready</p>");
  });

  it("lets an explicit bridge load independently of context resolution", () => {
    const element = new CFIframe();
    const bridge: FabricBridge = { resources: {} };
    const ref: CellRef = {
      id: "of:ignored-context" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let requests = 0;
    const runtime = {
      [$conn]: () => ({
        request: () => {
          requests++;
          return Promise.reject(new Error("ignored context refused"));
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    element.src = "<p>ready</p>";
    element.context = new CellHandle(runtime, ref);
    element.bridge = bridge;

    internals(element).willUpdate(contextChange());

    expect(templateValues(element).slice(0, 2)).toEqual([
      bridge,
      "<p>ready</p>",
    ]);
    expect(requests).toBe(0);
    expect(element._errorDetails).toBeNull();
  });

  it("retries context resolution when its error is dismissed", async () => {
    const ref: CellRef = {
      id: "of:context" as CellRef["id"],
      space: "did:key:test" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let requestCount = 0;
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requestCount++;
          if (requestCount === 1) {
            return Promise.reject(new Error("context refused"));
          }
          return request.type === RequestType.CellResolveAsCell
            ? Promise.resolve({
              cell: { ...ref, id: "of:resolved" as CellRef["id"] },
            })
            : Promise.resolve({ value: {} });
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const element = new CFIframe();
    element.src = "<p>recovered</p>";
    element.context = new CellHandle(runtime, ref);
    const failed = Promise.withResolvers<void>();
    element.requestUpdate = () => failed.resolve();

    internals(element).willUpdate(contextChange());
    await failed.promise;

    expect(element._errorDetails).toEqual({
      description: "context refused",
      source: "cf-iframe context",
      lineno: 0,
      colno: 0,
      stacktrace: expect.stringContaining("context refused"),
    });
    expect(templateValues(element).at(-1)).not.toBe("");

    const recovered = Promise.withResolvers<void>();
    element.requestUpdate = () => {
      if (templateValues(element)[1] === element.src) recovered.resolve();
    };
    internals(element).dismissError();
    await recovered.promise;

    expect(element._errorDetails).toBeNull();
    expect(templateValues(element)[1]).toBe(element.src);
  });

  it("hands the sandbox the outer frame the host's runtime names", () => {
    const element = new CFIframe();
    const serving = {
      iframeOuterFrameUrl: () => "/outer-frame",
    } as unknown as RuntimeClient;
    const inlining = {
      iframeOuterFrameUrl: () => undefined,
    } as unknown as RuntimeClient;

    // The third binding is the sandbox's `outerFrameUrl`, after its bridge
    // and its source.
    expect(templateValues(element)[2]).toBeUndefined();
    internals(element).onRuntime(serving);
    expect(templateValues(element)[2]).toBe("/outer-frame");
    internals(element).onRuntime(inlining);
    expect(templateValues(element)[2]).toBeUndefined();
    internals(element).onRuntime(serving);
    internals(element).onRuntime(undefined);
    expect(templateValues(element)[2]).toBeUndefined();
  });

  it("takes the outer frame from the runtime alone, never from a property", () => {
    const element = new CFIframe();
    // What a pattern's markup can reach is this element's properties.
    for (
      const name of ["outerFrameUrl", "_outerFrameUrl", "iframeOuterFrameUrl"]
    ) {
      expect(
        (CFIframe as unknown as { elementProperties: Map<string, unknown> })
          .elementProperties.has(name),
      ).toBe(false);
    }
    for (const name of ["outerFrameUrl", "_outerFrameUrl", "#outerFrameUrl"]) {
      (element as unknown as Record<string, string>)[name] =
        "https://elsewhere.test/";
    }
    expect(templateValues(element)[2]).toBeUndefined();
    internals(element).onRuntime(
      {
        iframeOuterFrameUrl: () => "/outer-frame",
      } as unknown as RuntimeClient,
    );
    expect(templateValues(element)[2]).toBe("/outer-frame");
    expect(element.render().strings.join("").match(/\.outerFrameUrl=/g))
      .toHaveLength(1);
  });

  it("translates sandbox events into component state and events", () => {
    const element = new CFIframe();
    const error = {
      description: "broken",
      source: "guest.js",
      lineno: 3,
      colno: 5,
      stacktrace: "broken at guest.js:3:5",
    };
    let loads = 0;
    let fixDetail: unknown;
    element.addEventListener("load", () => loads++);
    element.addEventListener("fix", (event) => {
      fixDetail = (event as CustomEvent).detail;
    });

    internals(element).onLoad();
    internals(element).onError(
      new CustomEvent("common-iframe-error", {
        detail: error,
      }),
    );
    expect(loads).toBe(1);
    expect(element._errorDetails).toEqual(error);
    expect(templateValues(element).at(-1)).not.toBe("");

    internals(element).fixError();
    expect(fixDetail).toEqual(error);
    expect(element._errorDetails).toBeNull();

    internals(element).onError(
      new CustomEvent("common-iframe-error", {
        detail: error,
      }),
    );
    internals(element).dismissError();
    expect(element._errorDetails).toBeNull();
  });
});
