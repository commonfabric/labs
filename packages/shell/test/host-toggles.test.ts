import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isPatternCoverageEnabled,
  runtimeHostFlags,
  setupHostToggles,
} from "../src/lib/host-toggles.ts";

class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

interface Harness {
  storage: FakeStorage;
  restore: () => void;
}

function setup(): Harness {
  const storage = new FakeStorage();
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });

  const cfGlobal = globalThis as { commonfabric?: unknown };
  const originalCommonfabric = cfGlobal.commonfabric;
  cfGlobal.commonfabric = {};

  const realInfo = console.info;
  console.info = () => {};

  return {
    storage,
    restore: () => {
      console.info = realInfo;
      if (storageDescriptor) {
        Object.defineProperty(globalThis, "localStorage", storageDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
      if (originalCommonfabric === undefined) {
        delete cfGlobal.commonfabric;
      } else {
        cfGlobal.commonfabric = originalCommonfabric;
      }
    },
  };
}

describe("setupHostToggles", () => {
  it("installs every commonfabric.* host-toggle command", () => {
    const h = setup();
    try {
      setupHostToggles();
      const cf = (globalThis as {
        commonfabric?: Record<string, unknown>;
      }).commonfabric;
      expect(typeof cf?.forwardWorkerConsole).toBe("function");
      expect(typeof cf?.cfcRenderCeiling).toBe("function");
      expect(typeof cf?.concurrentWatchRefresh).toBe("function");
    } finally {
      h.restore();
    }
  });
});

describe("isPatternCoverageEnabled", () => {
  it("defaults to false when reading localStorage throws", () => {
    // Accessing localStorage throws in some environments (disabled storage,
    // sandboxed frames). The toggle must swallow that and default off rather
    // than break runtime construction at login.
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is blocked");
      },
    });
    try {
      expect(isPatternCoverageEnabled()).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});

describe("runtimeHostFlags", () => {
  it("reads the render ceiling on and every other flag off when nothing is persisted", () => {
    // The render ceiling's key records an opt-out rather than an opt-in, so
    // a profile that has stored nothing has the ceiling.

    const h = setup();
    try {
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: false,
        cfcRenderCeiling: true,
        patternCoverage: false,
        concurrentWatchRefresh: false,
      });
    } finally {
      h.restore();
    }
  });

  it("reflects the persisted per-toggle state", () => {
    const h = setup();
    try {
      h.storage.map.set("forwardWorkerConsole", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: true,
        patternCoverage: false,
        concurrentWatchRefresh: false,
      });
      h.storage.map.set("cfcRenderCeiling", "false");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: false,
        patternCoverage: false,
        concurrentWatchRefresh: false,
      });
      h.storage.map.set("patternCoverage", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: false,
        patternCoverage: true,
        concurrentWatchRefresh: false,
      });
      h.storage.map.set("concurrentWatchRefresh", "true");
      expect(runtimeHostFlags()).toEqual({
        forwardWorkerConsole: true,
        cfcRenderCeiling: false,
        patternCoverage: true,
        concurrentWatchRefresh: true,
      });
    } finally {
      h.restore();
    }
  });
});
