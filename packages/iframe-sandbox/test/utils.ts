import type { FabricValue } from "@commonfabric/data-model";
import { defer } from "@commonfabric/utils/defer";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type {
  BridgeCell,
  BridgeResource,
  FabricBridge,
} from "../src/bridge.ts";
import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";

type Callback = (key: string, value: FabricValue) => void;
interface Context {
  [name: string]: FabricValue;
}

export class ContextShim {
  data: Context;
  resourceNames: Set<string>;
  callbacks: [number, string, Callback][];
  receiptIds: number;
  observers: [string, Callback][];
  bridge: FabricBridge;

  constructor(object: Context = {}, resourceNames: Iterable<string> = []) {
    this.data = object;
    this.resourceNames = new Set([...Object.keys(object), ...resourceNames]);
    this.callbacks = [];
    this.receiptIds = 0;
    this.observers = [];
    this.bridge = {
      resources: new Proxy<Record<string, BridgeResource>>({}, {
        get: (_target, key) =>
          typeof key === "string" && this.resourceNames.has(key)
            ? this.#resource(key)
            : undefined,
        ownKeys: () => [...this.resourceNames],
        getOwnPropertyDescriptor: (_target, key) =>
          typeof key === "string" && this.resourceNames.has(key)
            ? {
              configurable: true,
              enumerable: true,
              value: this.#resource(key),
            }
            : undefined,
      }),
    };
  }

  #resource(key: string): BridgeResource {
    return {
      kind: "cell",
      cell: this.#cell(key),
    };
  }

  #cell(key: string, path: Array<string | number> = []): BridgeCell {
    const get = (): FabricValue | undefined => {
      let value: unknown = this.get({} as CommonIframeSandboxElement, key);
      for (const part of path) {
        if (!isObjectOrArray(value)) return undefined;
        value = (value as Record<string, unknown>)[String(part)];
      }
      return value as FabricValue | undefined;
    };
    return {
      get,
      pull: get,
      set: (value) => {
        if (path.length === 0) {
          this.set({} as CommonIframeSandboxElement, key, value);
          return;
        }
        const root = this.get({} as CommonIframeSandboxElement, key);
        if (!isObjectOrArray(root)) {
          throw new TypeError("Cannot descend through a non-object value.");
        }
        let parent = root as Record<string, FabricValue>;
        for (const part of path.slice(0, -1)) {
          const child = parent[String(part)];
          if (!isObjectOrArray(child)) {
            throw new TypeError("Cannot descend through a non-object value.");
          }
          parent = child as Record<string, FabricValue>;
        }
        parent[String(path.at(-1))] = value;
        this.set({} as CommonIframeSandboxElement, key, root);
      },
      push: (...values) => {
        const current = get();
        if (!Array.isArray(current)) {
          throw new TypeError("push() requires an array value.");
        }
        this.set(
          {} as CommonIframeSandboxElement,
          key,
          [...current, ...values],
        );
      },
      sink: (listener) => {
        listener(get());
        const receipt = this.subscribe(
          {} as CommonIframeSandboxElement,
          key,
          () => listener(get()),
        );
        return () =>
          this.unsubscribe({} as CommonIframeSandboxElement, receipt);
      },
      key: (part) => this.#cell(key, [...path, part]),
    };
  }
  set(_element: CommonIframeSandboxElement, key: string, value: FabricValue) {
    this.data[key] = value;
    for (let i = 0; i < this.callbacks.length; i++) {
      const [_, callback_key, callback] = this.callbacks[i];
      if (key === callback_key) {
        callback(key, value);
      }
    }
    for (const [observer_key, observer] of [...this.observers]) {
      if (key === observer_key) {
        observer(key, value);
      }
    }
  }

  /**
   * Watches writes to `key`. Observers are held apart from `subscribe()`'s
   * callbacks so that a test watching a key does not consume a receipt id,
   * which would change the ids the guest's own subscriptions are given.
   */
  observe(key: string, callback: Callback): () => void {
    const entry: [string, Callback] = [key, callback];
    this.observers.push(entry);
    return () => {
      const index = this.observers.indexOf(entry);
      if (index !== -1) {
        this.observers.splice(index, 1);
      }
    };
  }

  get(_element: CommonIframeSandboxElement, key: string): FabricValue {
    return this.data[key];
  }

  subscribe(
    _element: CommonIframeSandboxElement,
    key: string,
    callback: Callback,
  ): number {
    const id = this.receiptIds++;
    this.callbacks.push([id, key, callback]);
    return id;
  }

  unsubscribe(_element: CommonIframeSandboxElement, receipt: number) {
    for (let i = 0; i < this.callbacks.length; i++) {
      const [id] = this.callbacks[i];
      if (id === receipt) {
        this.callbacks.splice(i, 1);
        return;
      }
    }
  }
}

export function assert(condition: boolean) {
  if (!condition) {
    throw new Error(`${condition} is not truthy.`);
  }
}

export function assertEquals(a: unknown, b: unknown) {
  if (a !== b) {
    throw new Error(`${a} does not equal ${b}.`);
  }
}

export function deepEquals(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertDeepEquals(a: unknown, b: unknown) {
  if (!deepEquals(a, b)) {
    throw new Error(
      `${JSON.stringify(a)} does not deep equal ${JSON.stringify(b)}.`,
    );
  }
}

const FIXTURE_ID = "common-iframe-csp-fixture-container";
export function cleanupFixtures() {
  for (const fixture of document.querySelectorAll(`[id^="${FIXTURE_ID}-"]`)) {
    fixture.remove();
  }
}

export function render(
  src: string,
  context = new ContextShim(),
): Promise<CommonIframeSandboxElement> {
  return new Promise((resolve) => {
    const parent = document.createElement("div");
    parent.id = `${FIXTURE_ID}-${(Math.random() * 1_000_000).toFixed(0)}`;
    const iframe = document.createElement(
      "common-iframe-sandbox",
    ) as CommonIframeSandboxElement;
    iframe.bridge = context.bridge;
    iframe.addEventListener("load", (_) => {
      resolve(iframe);
    });
    parent.appendChild(iframe);
    document.body.appendChild(parent);
    // @ts-ignore This is a lit property.
    iframe.src = src;
  });
}

export function invertPromise(promise: Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => promise.then(reject, resolve));
}

export function waitForEvent(
  element: HTMLElement,
  eventName: string,
  timeout = 1000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(`Timeout reached waiting for ${eventName}`);
    }, timeout);
    const handler = (e: Event) => {
      element.removeEventListener(eventName, handler);
      clearTimeout(timer);
      resolve(e);
    };
    element.addEventListener(eventName, handler);
  });
}

// Resolves once `key`'s value in `context` satisfies `predicate`. A guest's
// write reaches the context through the handler, so observing the context
// settles the wait when the write arrives. The current value is checked first,
// for a write that already landed before the wait began.
export function waitForContextValue(
  context: ContextShim,
  element: CommonIframeSandboxElement,
  key: string,
  predicate: (value: unknown) => boolean,
): Promise<void> {
  if (predicate(context.get(element, key))) {
    return Promise.resolve();
  }
  const deferred = defer();
  const stop = context.observe(key, (_key, value) => {
    if (predicate(value)) {
      stop();
      deferred.resolve();
    }
  });
  return deferred.promise;
}
