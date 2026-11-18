import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import { bootShell, type ShellBootDependencies } from "../src/lib/boot.ts";
import type { DeviceLinkFragment } from "../src/lib/device-link.ts";
import type { LoomPairingFragment } from "../src/lib/loom-pairing.ts";
import { ROOT_KEY } from "../src/lib/root-key.ts";

/** The key store as boot sees it. */
interface TestKeyStore {
  get(name: string): Promise<Identity | void>;
}

/** The root element as boot sees it. */
interface TestRoot {
  keyStore: TestKeyStore | undefined;
  setIdentity(identity: Identity): Promise<void>;
}

const DEVICE_LINK: DeviceLinkFragment = {
  kind: "entropy",
  entropy: new Uint8Array(32),
};

const PAIRING_LINK: LoomPairingFragment = {
  kind: "request",
  request: { code: "ABCD-EFGH", loomUrl: "http://localhost:9900" },
};

/**
 * Boot dependencies that log each step to `events`. The fragment consumers
 * hand out `deviceLinks` and `pairingLinks` in turn, then report absent.
 */
function bootPage(options: {
  deviceLinks?: DeviceLinkFragment[];
  pairingLinks?: LoomPairingFragment[];
  stored?: Identity;
  hasRoot?: boolean;
  serviceWorker?: boolean;
} = {}) {
  const events: string[] = [];
  const deviceLinks = [...options.deviceLinks ?? []];
  const pairingLinks = [...options.pairingLinks ?? []];
  const window = new EventTarget();
  const root: TestRoot = {
    keyStore: undefined,
    setIdentity: (identity) => {
      events.push(`set identity ${identity.did()}`);
      return Promise.resolve();
    },
  };
  const keyStore: TestKeyStore = {
    get: (name) => {
      events.push(`read ${name}`);
      return Promise.resolve(name === ROOT_KEY ? options.stored : undefined);
    },
  };
  const deps: ShellBootDependencies<TestKeyStore, TestRoot> = {
    consumeDeviceLinkFragment: () => {
      events.push("consume device link");
      return deviceLinks.shift() ?? { kind: "absent" };
    },
    handleDeviceLink: async (link, opts) => {
      events.push(`handle device link ${link.kind} ${JSON.stringify(opts)}`);
      await Promise.resolve();
      events.push("device link handled");
    },
    consumeLoomPairingFragment: () => {
      events.push("consume pairing link");
      return pairingLinks.shift() ?? { kind: "absent" };
    },
    handleLoomPairingLink: async (link, opts) => {
      events.push(`handle pairing link ${link.kind} ${JSON.stringify(opts)}`);
      await Promise.resolve();
      events.push("pairing link handled");
    },
    window,
    navigator: options.serviceWorker === false ? {} : {
      serviceWorker: {
        register: (url) => events.push(`register service worker ${url}`),
      },
    },
    environment: { ENVIRONMENT: "test", API_URL: new URL("http://api.test/") },
    prefetchDeployment: () => events.push("prefetch deployment"),
    setupHostToggles: () => events.push("set up host toggles"),
    findRoot: () => (options.hasRoot === false ? null : root),
    openKeyStore: () => {
      events.push(`open key store (root has one: ${!!root.keyStore})`);
      return Promise.resolve(keyStore);
    },
    startNavigation: (app) => {
      events.push(
        `start navigation (key store handed over: ${!!app.keyStore})`,
      );
    },
    publish: (app) => {
      events.push(`publish (root: ${app === root})`);
    },
  };
  return { deps, events, window, root, keyStore };
}

/** Runs `body` with `console.log` captured, returning the lines it logged. */
async function capturingLog(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const log = stub(console, "log", (line: string) => void lines.push(line));
  try {
    await body();
  } finally {
    log.restore();
  }
  return lines;
}

describe("bootShell()", () => {
  describe("startup", () => {
    it("consumes both fragments before its first await", async () => {
      const { deps, events } = bootPage();

      await capturingLog(async () => {
        const booted = bootShell(deps);
        const synchronous = [...events];
        await booted;

        expect(synchronous.slice(0, 2)).toEqual([
          "consume device link",
          "consume pairing link",
        ]);
        expect(synchronous).not.toContain(`read ${ROOT_KEY}`);
      });
    });

    it("runs the startup steps in order, publishing the root last", async () => {
      const { deps, events } = bootPage();

      await capturingLog(() => bootShell(deps));

      expect(events).toEqual([
        "consume device link",
        "consume pairing link",
        "register service worker /sw.js",
        "prefetch deployment",
        "set up host toggles",
        "open key store (root has one: false)",
        `read ${ROOT_KEY}`,
        "start navigation (key store handed over: true)",
        "publish (root: true)",
      ]);
    });

    it("finishes handling a device link, then a pairing link, before opening the key store", async () => {
      const { deps, events } = bootPage({
        deviceLinks: [DEVICE_LINK],
        pairingLinks: [PAIRING_LINK],
      });

      await capturingLog(() => bootShell(deps));

      const keyStoreOpened = events.indexOf(
        "open key store (root has one: false)",
      );
      expect(events.slice(keyStoreOpened - 4, keyStoreOpened)).toEqual([
        "handle device link entropy undefined",
        "device link handled",
        "handle pairing link request undefined",
        "pairing link handled",
      ]);
    });

    it("hands a malformed link to its handler too, so the failure is reported", async () => {
      const { deps, events } = bootPage({
        deviceLinks: [{ kind: "malformed" }],
        pairingLinks: [{ kind: "malformed" }],
      });

      await capturingLog(() => bootShell(deps));

      expect(events).toContain("handle device link malformed undefined");
      expect(events).toContain("handle pairing link malformed undefined");
    });

    it("calls neither handler when the address carries no link", async () => {
      const { deps, events } = bootPage();

      await capturingLog(() => bootShell(deps));

      expect(events.filter((event) => event.startsWith("handle"))).toEqual(
        [],
      );
    });

    it("logs each environment value by name", async () => {
      const { deps } = bootPage();

      const lines = await capturingLog(() => bootShell(deps));

      expect(lines).toEqual([
        "ENVIRONMENT=test",
        "API_URL=http://api.test/",
      ]);
    });

    it("registers no service worker where the browser has none", async () => {
      const { deps, events } = bootPage({ serviceWorker: false });

      await capturingLog(() => bootShell(deps));

      expect(events.filter((event) => event.includes("service worker")))
        .toEqual([]);
      expect(events.at(-1)).toBe("publish (root: true)");
    });

    it("rejects, opening no key store, when the page has no root view", async () => {
      const { deps, events } = bootPage({
        deviceLinks: [DEVICE_LINK],
        hasRoot: false,
      });

      await capturingLog(async () => {
        await expect(bootShell(deps)).rejects.toThrow("No root view found.");
      });

      expect(events.filter((event) => !event.startsWith("consume"))).toEqual([
        "register service worker /sw.js",
        "prefetch deployment",
        "set up host toggles",
      ]);
    });
  });

  describe("identity", () => {
    it("restores the stored root identity before installing navigation", async () => {
      const identity = await Identity.generate({ implementation: "noble" });
      const { deps, events, root, keyStore } = bootPage({ stored: identity });

      await capturingLog(() => bootShell(deps));

      expect(root.keyStore).toBe(keyStore);
      expect(events.slice(-3)).toEqual([
        `set identity ${identity.did()}`,
        "start navigation (key store handed over: true)",
        "publish (root: true)",
      ]);
    });

    it("leaves the shell signed out when no identity is stored", async () => {
      const { deps, events, root, keyStore } = bootPage();

      await capturingLog(() => bootShell(deps));

      expect(root.keyStore).toBe(keyStore);
      expect(events.filter((event) => event.startsWith("set identity")))
        .toEqual([]);
    });
  });

  describe("`hashchange`", () => {
    it("does nothing when the new address carries neither link", async () => {
      const { deps, events, window } = bootPage();
      await capturingLog(() => bootShell(deps));
      events.length = 0;

      window.dispatchEvent(new Event("hashchange"));

      expect(events).toEqual(["consume device link", "consume pairing link"]);
    });

    it("hands a device link to its handler, reloading on a replace", async () => {
      const { deps, events, window } = bootPage({
        deviceLinks: [{ kind: "absent" }, DEVICE_LINK],
      });
      await capturingLog(() => bootShell(deps));
      events.length = 0;

      window.dispatchEvent(new Event("hashchange"));

      expect(events).toEqual([
        "consume device link",
        'handle device link entropy {"reloadOnReplace":true}',
        "consume pairing link",
      ]);
    });

    it("hands a pairing link to its handler, reloading on an accept", async () => {
      const { deps, events, window } = bootPage({
        pairingLinks: [{ kind: "absent" }, PAIRING_LINK],
      });
      await capturingLog(() => bootShell(deps));
      events.length = 0;

      window.dispatchEvent(new Event("hashchange"));

      expect(events).toEqual([
        "consume device link",
        "consume pairing link",
        'handle pairing link request {"reloadOnAccept":true}',
      ]);
    });
  });
});
