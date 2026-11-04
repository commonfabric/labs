import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { publishShellApp } from "../src/globals.ts";
import type { ShellApp } from "../src/lib/app-state.ts";

describe("globals", () => {
  describe("publishShellApp()", () => {
    it("makes the app available before notifying readiness listeners", () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, "app");
      const observed: ShellApp[] = [];
      const onReady = () => observed.push(globalThis.app);
      const app = {};

      Reflect.deleteProperty(globalThis, "app");
      globalThis.addEventListener("cf-shell-ready", onReady);
      try {
        publishShellApp(app as ShellApp);

        expect(globalThis.app).toBe(app);
        expect(observed).toHaveLength(1);
        expect(observed[0]).toBe(app);
      } finally {
        globalThis.removeEventListener("cf-shell-ready", onReady);
        if (original) Object.defineProperty(globalThis, "app", original);
        else Reflect.deleteProperty(globalThis, "app");
      }
    });
  });
});
