/// <reference lib="deno.unstable" />

import { expect } from "@std/expect";
import plugin from "./lint-test-registration.ts";
import { describe, it } from "@commonfabric/test-support/test";

function diagnose(source: string): string[] {
  return Deno.lint.runPlugin(plugin, "sample.test.ts", source).map((d) =>
    d.message
  );
}

describe("lint-test-registration", () => {
  it("reports a test registered with Deno.test", () => {
    const messages = diagnose(`Deno.test("a", () => {});`);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("rather than with `Deno.test`");
  });

  it("reports a hook registered on Deno.test", () => {
    expect(diagnose(`Deno.test.beforeAll(() => {});`).length).toBe(1);
  });

  it("reports Deno.test reached through brackets or destructuring", () => {
    expect(diagnose(`Deno["test"]("a", () => {});`).length).toBe(1);
    expect(diagnose(`const { test } = Deno;`).length).toBe(1);
    expect(diagnose(`const { env } = Deno;`)).toEqual([]);
  });

  it("reports an import or a re-export of @std/testing/bdd", () => {
    for (
      const source of [
        `import { describe } from "@std/testing/bdd";`,
        `export { it } from "@std/testing/bdd";`,
        `export * from "@std/testing/bdd";`,
        `import { it } from "jsr:@std/testing@1.0.19/bdd";`,
        `await import("@std/testing/bdd");`,
      ]
    ) {
      const messages = diagnose(source);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("not from `@std/testing/bdd`");
    }
  });

  it("reports an unload event a program makes, and no other event", () => {
    for (
      const source of [
        `dispatchEvent(new Event("unload"));`,
        `dispatchEvent(new CustomEvent("unload"));`,
        "dispatchEvent(new Event(`unload`));",
      ]
    ) {
      const messages = diagnose(source);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain("Do not make an `unload` event");
    }
    expect(diagnose(`dispatchEvent(new Event("load"));`)).toEqual([]);
  });

  it("reports only an event kind or a specifier it can read literally", () => {
    for (
      const source of [
        `dispatchEvent(new Event(kind));`,
        "dispatchEvent(new Event(`un${'load'}`));",
        `dispatchEvent(new Event(1));`,
        `await import(specifier);`,
        "await import(`@std/testing/${'bdd'}`);",
      ]
    ) {
      expect(diagnose(source)).toEqual([]);
    }
  });

  it("reports nothing for the module's own functions or other names", () => {
    expect(diagnose(`
      import { describe, it, test } from "@commonfabric/test-support/test";
      import { stub } from "@std/testing/mock";
      describe("a", () => { it("b", () => {}); });
      test("c", () => {});
      Deno.bench("d", () => {});
      const t = { test: 1 }; t.test;
      Deno["bench"]; Deno[name];
      import { x } from "@std/testing/bdd-like";
    `)).toEqual([]);
  });
});
