import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isCfcRenderCeilingEnabled,
  setupCfcRenderCeilingToggle,
} from "../src/lib/render-ceiling.ts";
// Load the ambient-globals module so its declaration of
// `commonfabric.cfcRenderCeiling` is exercised alongside the toggle.
import "../src/globals.ts";

const STORAGE_KEY = "cfcRenderCeiling";

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
    if (this.throwOnWrite) throw new Error("write blocked");
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
    commonfabric?: { cfcRenderCeiling?: unknown };
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
    commonfabric?: { cfcRenderCeiling?: (enabled?: boolean) => void };
  }).commonfabric;
  if (!cf?.cfcRenderCeiling) {
    throw new Error("cfcRenderCeiling was not installed");
  }
  return cf.cfcRenderCeiling;
}

describe("isCfcRenderCeilingEnabled", () => {
  it('is true unless the key reads exactly "false"', () => {
    // The key records an opt-out, so absence is the ceiling being on. Only
    // the one spelling the toggle writes turns it off; a value the toggle
    // never wrote leaves the profile at the default rather than opting it
    // out on a spelling nobody chose.

    const h = setup();
    try {
      expect(isCfcRenderCeilingEnabled()).toBe(true);
      h.storage.map.set(STORAGE_KEY, "false");
      expect(isCfcRenderCeilingEnabled()).toBe(false);
      h.storage.map.set(STORAGE_KEY, "no");
      expect(isCfcRenderCeilingEnabled()).toBe(true);
      h.storage.map.set(STORAGE_KEY, "true");
      expect(isCfcRenderCeilingEnabled()).toBe(true);
    } finally {
      h.restore();
    }
  });

  it("is true when reading localStorage throws", () => {
    // A profile whose storage cannot be read has stated no opt-out.

    const h = setup();
    try {
      h.storage.throwOnRead = true;
      expect(isCfcRenderCeilingEnabled()).toBe(true);
    } finally {
      h.restore();
    }
  });
});

describe("setupCfcRenderCeilingToggle", () => {
  it("installs the command and stays silent under the default posture", () => {
    const h = setup();
    try {
      setupCfcRenderCeilingToggle();
      expect(typeof command()).toBe("function");
      expect(h.info).toEqual([]);
    } finally {
      h.restore();
    }
  });

  it("prints the OFF hint when the profile has opted out", () => {
    // The opted-out profile renders labeled content ungated, so the reduced
    // posture is what the console has to say.

    const h = setup();
    try {
      h.storage.map.set(STORAGE_KEY, "false");
      setupCfcRenderCeilingToggle();
      expect(h.info.join("\n")).toContain("is OFF");
    } finally {
      h.restore();
    }
  });
});

describe("commonfabric.cfcRenderCeiling", () => {
  it("clears the opt-out and notes the reload requirement when enabling", () => {
    const h = setup();
    try {
      h.storage.map.set(STORAGE_KEY, "false");
      setupCfcRenderCeilingToggle();
      command()(); // default argument enables
      expect(h.storage.map.has(STORAGE_KEY)).toBe(false);
      // The ceiling is fixed at runtime initialization — the toggle cannot
      // live-apply, so the confirmation must say when it takes effect.
      expect(h.info.join("\n")).toContain("enabled");
      expect(h.info.join("\n")).toContain("next runtime");
    } finally {
      h.restore();
    }
  });

  it("persists the opt-out when disabling", () => {
    const h = setup();
    try {
      setupCfcRenderCeilingToggle();
      command()(false);
      expect(h.storage.map.get(STORAGE_KEY)).toBe("false");
      expect(h.info.join("\n")).toContain("disabled");
    } finally {
      h.restore();
    }
  });

  it("logs and bails out when persisting the opt-out fails", () => {
    const h = setup();
    try {
      setupCfcRenderCeilingToggle();
      h.storage.throwOnWrite = true;
      command()(false);
      expect(h.errors.join("\n")).toContain("Could not persist");
      // The "enabled"/"disabled" confirmation is not logged on failure.
      expect(h.info.join("\n")).not.toContain("disabled");
    } finally {
      h.restore();
    }
  });

  it("logs and bails out when clearing the opt-out fails", () => {
    // Enabling clears the key rather than writing one, so a storage that
    // refuses writes fails this direction too, and on the branch the
    // disabling case never reaches.

    const h = setup();
    try {
      setupCfcRenderCeilingToggle();
      h.storage.map.set(STORAGE_KEY, "false");
      h.storage.throwOnWrite = true;
      command()();
      expect(h.errors.join("\n")).toContain("Could not persist");
      expect(h.info.join("\n")).not.toContain("enabled");
      // The opt-out the clear could not remove is still recorded.
      expect(h.storage.map.get(STORAGE_KEY)).toBe("false");
    } finally {
      h.restore();
    }
  });
});
