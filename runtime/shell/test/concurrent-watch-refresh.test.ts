import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isConcurrentWatchRefreshEnabled,
  setupConcurrentWatchRefreshToggle,
} from "../src/lib/concurrent-watch-refresh.ts";
// Load the ambient-globals module so the `commonfabric` global is typed for
// the cast below (the command rides its `[key: string]: unknown` index
// signature, matching how cfcRenderCeiling is typed).
import "../src/globals.ts";

const STORAGE_KEY = "concurrentWatchRefresh";

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

interface Harness {
  storage: FakeStorage;
  info: string[];
  errors: string[];
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
    commonfabric?: { concurrentWatchRefresh?: unknown };
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
    commonfabric?: { concurrentWatchRefresh?: (enabled?: boolean) => void };
  }).commonfabric;
  if (!cf?.concurrentWatchRefresh) {
    throw new Error("concurrentWatchRefresh was not installed");
  }
  return cf.concurrentWatchRefresh;
}

describe("isConcurrentWatchRefreshEnabled", () => {
  it('is false when the key is absent and true when set to "true"', () => {
    const h = setup();
    try {
      expect(isConcurrentWatchRefreshEnabled()).toBe(false);
      h.storage.map.set(STORAGE_KEY, "true");
      expect(isConcurrentWatchRefreshEnabled()).toBe(true);
      h.storage.map.set(STORAGE_KEY, "yes");
      expect(isConcurrentWatchRefreshEnabled()).toBe(false);
    } finally {
      h.restore();
    }
  });

  it("is false when reading localStorage throws", () => {
    const h = setup();
    try {
      h.storage.throwOnRead = true;
      expect(isConcurrentWatchRefreshEnabled()).toBe(false);
    } finally {
      h.restore();
    }
  });
});

describe("setupConcurrentWatchRefreshToggle", () => {
  it("installs the command and stays silent while disabled (default posture)", () => {
    const h = setup();
    try {
      setupConcurrentWatchRefreshToggle();
      expect(typeof command()).toBe("function");
      expect(h.info).toEqual([]);
    } finally {
      h.restore();
    }
  });

  it("prints the ON hint when already enabled", () => {
    const h = setup();
    try {
      h.storage.map.set(STORAGE_KEY, "true");
      setupConcurrentWatchRefreshToggle();
      expect(h.info.join("\n")).toContain("is ON");
    } finally {
      h.restore();
    }
  });
});

describe("commonfabric.concurrentWatchRefresh", () => {
  it("persists and notes the reload requirement when enabling", () => {
    const h = setup();
    try {
      setupConcurrentWatchRefreshToggle();
      command()(); // default argument enables
      expect(h.storage.map.get(STORAGE_KEY)).toBe("true");
      // The storage setting is fixed at StorageManager.open — the toggle
      // cannot live-apply, so the confirmation must say when it takes effect.
      expect(h.info.join("\n")).toContain("enabled");
      expect(h.info.join("\n")).toContain("next runtime");
    } finally {
      h.restore();
    }
  });

  it("clears the key when disabling", () => {
    const h = setup();
    try {
      h.storage.map.set(STORAGE_KEY, "true");
      setupConcurrentWatchRefreshToggle();
      command()(false);
      expect(h.storage.map.has(STORAGE_KEY)).toBe(false);
      expect(h.info.join("\n")).toContain("disabled");
    } finally {
      h.restore();
    }
  });

  it("logs and bails out when persistence fails", () => {
    const h = setup();
    try {
      setupConcurrentWatchRefreshToggle();
      h.storage.throwOnWrite = true;
      command()(true);
      expect(h.errors.join("\n")).toContain("Could not persist");
      // The "enabled"/"disabled" confirmation is not logged on failure.
      expect(h.info.join("\n")).not.toContain("enabled");
    } finally {
      h.restore();
    }
  });
});
