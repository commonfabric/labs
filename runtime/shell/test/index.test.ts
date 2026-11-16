// deno-lint-ignore-file cf-imports/no-inline-module-import -- the entry's
// module graph reaches @commonfabric/ui, whose components extend a bare
// HTMLElement as they load, and `env.ts` reads the page's location as it
// loads, so both can only load once the test has installed stand-ins.

/**
 * Loads the shell's entry module once, into a stand-in page, and checks that
 * each thing `bootShell()` is handed is the real one: the browser's key store,
 * the page's root view, its service worker, the deployment read, the console
 * commands, `Navigation`, and the address the `hashchange` listeners read.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { Identity, KeyStore } from "@commonfabric/identity";

import { installBrowserGlobals, installGlobals } from "./browser-globals.ts";
import type * as EnvModule from "../src/lib/env.ts";
import { ROOT_KEY } from "../src/lib/root-key.ts";

const HREF = "http://localhost:8000/common-knowledge";

/** The `commonfabric.*` console commands `setupHostToggles()` installs. */
const HOST_TOGGLE_COMMANDS = [
  "cfcRenderCeiling",
  "concurrentWatchRefresh",
  "forwardWorkerConsole",
  "syncCidReferences",
];

/** An IndexedDB request: an event target whose result is set before it fires. */
type MemoryRequest = EventTarget & { result: unknown };

/**
 * A request that succeeds in a later microtask, as an IndexedDB request does,
 * with the result `produce` returns. `produce` is handed the request, so that
 * it can fire events on it first.
 */
function succeeding(
  produce: (request: MemoryRequest) => unknown,
): MemoryRequest {
  const request: MemoryRequest = Object.assign(new EventTarget(), {
    result: undefined,
  });
  queueMicrotask(() => {
    request.result = produce(request);
    request.dispatchEvent(new Event("success"));
  });
  return request;
}

/**
 * An in-memory IndexedDB holding as much as `KeyStore` uses: databases of
 * named object stores, an upgrade on the first open of each, and reads and
 * writes by key.
 */
function memoryIndexedDB() {
  const databases = new Map<string, Map<string, Map<unknown, unknown>>>();
  const database = (stores: Map<string, Map<unknown, unknown>>) =>
    Object.assign(new EventTarget(), {
      createObjectStore: (name: string) => void stores.set(name, new Map()),
      transaction: (name: string) => ({
        objectStore: () => {
          const store = stores.get(name);
          if (!store) throw new Error(`No object store "${name}".`);
          return {
            get: (key: unknown) => succeeding(() => store.get(key)),
            put: (value: unknown, key: unknown) =>
              succeeding(() => void store.set(key, value)),
          };
        },
      }),
    });
  return {
    open: (name: string, version: number) =>
      succeeding((request) => {
        const existing = databases.get(name);
        const stores = existing ?? new Map();
        databases.set(name, stores);
        request.result = database(stores);
        if (!existing) {
          request.dispatchEvent(
            Object.assign(new Event("upgradeneeded"), {
              oldVersion: 0,
              newVersion: version,
            }),
          );
        }
        return request.result;
      }),
  };
}

/** An element the page creates: what `reportDeviceLinkFailure()` sets on one. */
type PageElement = EventTarget & { failure?: string };

describe("index", () => {
  // `bootShell()`'s steps and their order are `boot.test.ts`'s to hold. These
  // cases hold what only loading the entry shows: that each step reaches the
  // page it is meant to.

  /** What the root view, history, and readiness listeners saw, in order. */
  const events: string[] = [];
  const registered: string[] = [];
  const history: string[] = [];
  const appended: PageElement[] = [];
  const logged: string[] = [];
  const listeners: [string, EventListenerOrEventListenerObject][] = [];
  const location = {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    origin: "http://localhost:8000",
    pathname: new URL(HREF).pathname,
    href: HREF,
    hash: "",
  };
  const root: {
    keyStore: KeyStore | undefined;
    setIdentity(identity: Identity): Promise<void>;
    setView(view: unknown): void;
  } = {
    keyStore: undefined,
    setIdentity: (identity: Identity) => {
      events.push(`set identity ${identity.did()}`);
      return Promise.resolve();
    },
    setView: (view: unknown) => {
      events.push(`set view ${JSON.stringify(view)}`);
    },
  };
  let identity: Identity;
  let env: typeof EnvModule;
  let prefetch: Stub;
  let restore: () => void;

  beforeAll(async () => {
    const restoreBrowser = installBrowserGlobals(HREF);
    const addEventListener = globalThis.addEventListener.bind(globalThis);
    const restorePage = installGlobals({
      document: {
        ...globalThis.document,
        querySelector: (selector: string) =>
          selector === "x-root-view" ? root : null,
        createElement: () =>
          Object.assign(new EventTarget(), {
            style: {},
            setAttribute() {},
            append() {},
            appendChild() {},
            remove() {},
          }),
        body: {
          style: {},
          appendChild: (element: PageElement) => appended.push(element),
        },
      },
      location,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) =>
          history.push(url),
      },
      navigator: {
        platform: "",
        userAgent: "deno",
        serviceWorker: { register: (url: string) => registered.push(url) },
      },
      indexedDB: memoryIndexedDB(),
      localStorage: { getItem: () => null },
      app: undefined,
      // Recorded so that each listener the entry installs on the page comes
      // off again after the last case, leaving other files' tests a page with
      // no `Navigation` and no `hashchange` listener on it.
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        listeners.push([type, listener]);
        addEventListener(type, listener, options);
      },
    });

    identity = await Identity.generate({ implementation: "noble" });
    await (await KeyStore.open()).set(ROOT_KEY, identity);

    // Only the commands come off, the loggers' registrations on the same
    // object being shared with every other module in the process.
    const commands = new Map(
      HOST_TOGGLE_COMMANDS.map((name) => [
        name,
        globalThis.commonfabric?.[name],
      ]),
    );
    for (const name of HOST_TOGGLE_COMMANDS) {
      Reflect.deleteProperty(globalThis.commonfabric ?? {}, name);
    }

    // The read itself is the process's once any test has started it, since
    // `shellDeployment` holds what it reads for the page's lifetime, so the
    // entry's call is observed in its place, and nothing is fetched.
    env = await import("../src/lib/env.ts");
    prefetch = stub(env.shellDeployment, "prefetch");
    globalThis.addEventListener("cf-shell-ready", () => {
      events.push(`ready (app is root: ${Object.is(globalThis.app, root)})`);
    });

    const log = stub(console, "log", (line: string) => void logged.push(line));
    const info = stub(console, "info");
    try {
      await import("../src/index.ts");
    } finally {
      log.restore();
      info.restore();
    }

    restore = () => {
      for (const [type, listener] of listeners) {
        globalThis.removeEventListener(type, listener);
      }
      prefetch.restore();
      for (const [name, command] of commands) {
        if (command === undefined) {
          Reflect.deleteProperty(globalThis.commonfabric, name);
        } else globalThis.commonfabric[name] = command;
      }
      restorePage();
      restoreBrowser();
    };
  });

  afterAll(() => restore());

  it("hands the root view the browser's key store, signed in as the identity it holds", async () => {
    expect(root.keyStore).toBeInstanceOf(KeyStore);
    expect((await root.keyStore?.get(ROOT_KEY))?.did()).toBe(identity.did());
    expect(events[0]).toBe(`set identity ${identity.did()}`);
  });

  it("applies the address's view to the root view and to history", () => {
    expect(events[1]).toBe(
      `set view ${JSON.stringify({ spaceName: "common-knowledge" })}`,
    );
    expect(history[0]).toBe("/common-knowledge");
  });

  it("publishes the root view as `app` last, announcing `cf-shell-ready`", () => {
    expect(globalThis.app).toBe(root);
    expect(events).toEqual([
      `set identity ${identity.did()}`,
      `set view ${JSON.stringify({ spaceName: "common-knowledge" })}`,
      "ready (app is root: true)",
    ]);
  });

  it("registers the service worker at `/sw.js`", () => {
    expect(registered).toEqual(["/sw.js"]);
  });

  it("logs the build's environment, API URL, and commit", () => {
    expect(logged).toEqual([
      `ENVIRONMENT=${env.ENVIRONMENT}`,
      `API_URL=${env.API_URL}`,
      `COMMIT_SHA=${env.COMMIT_SHA}`,
    ]);
  });

  it("starts the deployment read once", () => {
    expect(prefetch.calls.length).toBe(1);
  });

  it("installs the host-toggle console commands", () => {
    expect(
      HOST_TOGGLE_COMMANDS.filter((name) =>
        typeof globalThis.commonfabric[name] !== "function"
      ),
    ).toEqual([]);
  });

  describe("`hashchange`", () => {
    it("writes nothing to history and shows nothing when the address carries no link", () => {
      const written = history.length;

      globalThis.dispatchEvent(new Event("hashchange"));

      expect(history.length).toBe(written);
      expect(appended).toEqual([]);
    });

    it("scrubs a device link from the address and reports one it cannot read", () => {
      location.hash = "#k=!";
      location.href = `${HREF}#k=!`;
      try {
        const written = history.length;

        globalThis.dispatchEvent(new Event("hashchange"));

        expect(history.slice(written)).toEqual([HREF]);
        expect(appended.map((element) => element.failure)).toEqual([
          "unreadable",
        ]);
      } finally {
        location.hash = "";
        location.href = HREF;
        for (const element of appended.splice(0)) {
          element.dispatchEvent(new Event("device-link-result"));
        }
      }
    });
  });
});
