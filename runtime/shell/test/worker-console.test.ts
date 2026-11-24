import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isWorkerConsoleForwardingEnabled,
  setupWorkerConsoleToggle,
} from "../src/lib/worker-console.ts";
// Load the ambient-globals module so its declaration of
// `commonfabric.forwardWorkerConsole` is exercised alongside the toggle.
import "../src/globals.ts";

const STORAGE_KEY = "forwardWorkerConsole";

class FakeStorage {
  map = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;
  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("read blocked");
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("write blocked");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface FakeRuntime {
  calls: boolean[];
  setForwardWorkerConsole: (enabled: boolean) => Promise<void>;
}

function makeRuntime(reject = false): FakeRuntime {
  const calls: boolean[] = [];
  return {
    calls,
    setForwardWorkerConsole: (enabled: boolean) => {
      calls.push(enabled);
      return reject
        ? Promise.reject(new Error("runtime gone"))
        : Promise.resolve();
    },
  };
}

interface Harness {
  storage: FakeStorage;
  info: string[];
  errors: string[];
  setRuntime: (rt: FakeRuntime | undefined) => void;
  restore: () => void;
}

function setup(): Harness {
  const storage = new FakeStorage();
  const info: string[] = [];
  const errors: string[] = [];

  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });

  const cfGlobal = globalThis as {
    commonfabric?: { rt?: unknown; forwardWorkerConsole?: unknown };
  };
  const originalCommonfabric = cfGlobal.commonfabric;
  cfGlobal.commonfabric = {};

  const realInfo = console.info;
  const realError = console.error;
  console.info = (...args: unknown[]) => info.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  return {
    storage,
    info,
    errors,
    setRuntime: (rt) => {
      // Mutate `.rt` in place so the installed `forwardWorkerConsole` command
      // survives — replacing the object would drop it.
      const cf = (cfGlobal.commonfabric ??= {});
      cf.rt = rt;
    },
    restore: () => {
      console.info = realInfo;
      console.error = realError;
      if (storageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", storageDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
      if (originalCommonfabric === undefined) {
        delete (globalThis as { commonfabric?: unknown }).commonfabric;
      } else {
        cfGlobal.commonfabric = originalCommonfabric;
      }
    },
  };
}

function command(): (enabled?: boolean) => void {
  const cf = (globalThis as {
    commonfabric?: { forwardWorkerConsole?: (enabled?: boolean) => void };
  }).commonfabric;
  if (!cf?.forwardWorkerConsole) {
    throw new Error("forwardWorkerConsole was not installed");
  }
  return cf.forwardWorkerConsole;
}

describe("worker-console", () => {
  describe("isWorkerConsoleForwardingEnabled", () => {
    it('is false when the key is absent and true when set to "true"', () => {
      const h = setup();
      try {
        expect(isWorkerConsoleForwardingEnabled()).toBe(false);
        h.storage.map.set(STORAGE_KEY, "true");
        expect(isWorkerConsoleForwardingEnabled()).toBe(true);
        h.storage.map.set(STORAGE_KEY, "yes");
        expect(isWorkerConsoleForwardingEnabled()).toBe(false);
      } finally {
        h.restore();
      }
    });

    it("is false when reading localStorage throws", () => {
      const h = setup();
      try {
        h.storage.throwOnRead = true;
        expect(isWorkerConsoleForwardingEnabled()).toBe(false);
      } finally {
        h.restore();
      }
    });
  });

  describe("setupWorkerConsoleToggle", () => {
    it("prints the OFF hint and installs the command when disabled", () => {
      const h = setup();
      try {
        setupWorkerConsoleToggle();
        expect(h.info.join("\n")).toContain("is OFF");
        expect(typeof command()).toBe("function");
      } finally {
        h.restore();
      }
    });

    it("prints the ON hint when already enabled", () => {
      const h = setup();
      try {
        h.storage.map.set(STORAGE_KEY, "true");
        setupWorkerConsoleToggle();
        expect(h.info.join("\n")).toContain("is ON");
      } finally {
        h.restore();
      }
    });
  });

  describe("commonfabric.forwardWorkerConsole", () => {
    it("persists, applies to the running runtime, and logs when enabling", async () => {
      const h = setup();
      const rt = makeRuntime();
      try {
        setupWorkerConsoleToggle();
        h.setRuntime(rt);
        command()(); // default argument enables
        await Promise.resolve();
        expect(h.storage.map.get(STORAGE_KEY)).toBe("true");
        expect(rt.calls).toEqual([true]);
        expect(h.info.join("\n")).toContain("enabled");
      } finally {
        h.restore();
      }
    });

    it("clears the key, applies to the running runtime, and logs when disabling", async () => {
      const h = setup();
      const rt = makeRuntime();
      try {
        h.storage.map.set(STORAGE_KEY, "true");
        setupWorkerConsoleToggle();
        h.setRuntime(rt);
        command()(false);
        await Promise.resolve();
        expect(h.storage.map.has(STORAGE_KEY)).toBe(false);
        expect(rt.calls).toEqual([false]);
        expect(h.info.join("\n")).toContain("disabled");
      } finally {
        h.restore();
      }
    });

    it("persists without a runtime when none is running", () => {
      const h = setup();
      try {
        setupWorkerConsoleToggle();
        h.setRuntime(undefined);
        command()(true);
        expect(h.storage.map.get(STORAGE_KEY)).toBe("true");
        expect(h.info.join("\n")).toContain("enabled");
      } finally {
        h.restore();
      }
    });

    it("logs and bails out when persistence fails, without touching the runtime", () => {
      const h = setup();
      const rt = makeRuntime();
      try {
        setupWorkerConsoleToggle();
        h.setRuntime(rt);
        h.storage.throwOnWrite = true;
        command()(true);
        expect(h.errors.join("\n")).toContain("Could not persist");
        expect(rt.calls).toEqual([]);
        // The "enabled"/"disabled" confirmation is not logged on failure.
        expect(h.info.join("\n")).not.toContain("enabled");
      } finally {
        h.restore();
      }
    });

    it("reports a runtime that rejects the live update", async () => {
      const h = setup();
      const rt = makeRuntime(true);
      try {
        setupWorkerConsoleToggle();
        h.setRuntime(rt);
        command()(true);
        // Let the rejected live-update promise settle so its catch runs.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(rt.calls).toEqual([true]);
        expect(h.errors.join("\n")).toContain("Could not update the running");
      } finally {
        h.restore();
      }
    });
  });
});
