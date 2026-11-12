import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isSyncCidReferencesEnabled,
  setupSyncCidReferencesToggle,
} from "../src/lib/sync-cid-references.ts";
// Load the ambient-globals module so the `commonfabric` global is typed for
// the cast below (the command rides its `[key: string]: unknown` index
// signature, matching how cfcRenderCeiling is typed).
import "../src/globals.ts";

const STORAGE_KEY = "syncCidReferences";

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
    commonfabric?: { syncCidReferences?: unknown };
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
    commonfabric?: { syncCidReferences?: (enabled?: boolean) => void };
  }).commonfabric;
  if (!cf?.syncCidReferences) {
    throw new Error("syncCidReferences was not installed");
  }
  return cf.syncCidReferences;
}

describe("sync-cid-references", () => {
  describe("isSyncCidReferencesEnabled()", () => {
    it('returns false when the key is absent and true when it is "true"', () => {
      const h = setup();
      try {
        expect(isSyncCidReferencesEnabled()).toBe(false);
        h.storage.map.set(STORAGE_KEY, "true");
        expect(isSyncCidReferencesEnabled()).toBe(true);
        h.storage.map.set(STORAGE_KEY, "yes");
        expect(isSyncCidReferencesEnabled()).toBe(false);
      } finally {
        h.restore();
      }
    });

    it("returns false when reading localStorage throws", () => {
      const h = setup();
      try {
        h.storage.throwOnRead = true;
        expect(isSyncCidReferencesEnabled()).toBe(false);
      } finally {
        h.restore();
      }
    });
  });

  describe("setupSyncCidReferencesToggle()", () => {
    it("installs the command and logs nothing while the toggle is off", () => {
      const h = setup();
      try {
        setupSyncCidReferencesToggle();
        expect(typeof command()).toBe("function");
        expect(h.info).toStrictEqual([]);
      } finally {
        h.restore();
      }
    });

    it("logs the hint that the toggle is on when it is already set", () => {
      const h = setup();
      try {
        h.storage.map.set(STORAGE_KEY, "true");
        setupSyncCidReferencesToggle();
        expect(h.info.join("\n")).toContain("are ON");
      } finally {
        h.restore();
      }
    });
  });

  describe("commonfabric.syncCidReferences()", () => {
    it("persists the setting and says it takes effect on the next runtime", () => {
      const h = setup();
      try {
        setupSyncCidReferencesToggle();
        command()();
        expect(h.storage.map.get(STORAGE_KEY)).toBe("true");
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
        setupSyncCidReferencesToggle();
        command()(false);
        expect(h.storage.map.has(STORAGE_KEY)).toBe(false);
        expect(h.info.join("\n")).toContain("disabled");
      } finally {
        h.restore();
      }
    });

    it("logs an error and confirms nothing when persisting fails", () => {
      const h = setup();
      try {
        setupSyncCidReferencesToggle();
        h.storage.throwOnWrite = true;
        command()(true);
        expect(h.errors.join("\n")).toContain("Could not persist");
        expect(h.info.join("\n")).not.toContain("enabled");
      } finally {
        h.restore();
      }
    });
  });
});
