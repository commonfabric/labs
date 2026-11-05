/**
 * Every class a `data-model` module exports freezes itself and its prototype
 * as it is defined. This walks the whole source tree rather than a list of
 * classes, so a class added without the freeze fails here without anyone
 * having to remember to name it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

/** The package's source tree. */
const SRC_DIR = new URL("../src/", import.meta.url);

/**
 * Helper for the walk below, which lists the URL of every TypeScript module
 * under `dir`.
 */
function sourceModulesUnder(dir: URL): URL[] {
  const result: URL[] = [];

  for (const entry of Deno.readDirSync(dir)) {
    if (entry.isDirectory) {
      for (const module of sourceModulesUnder(new URL(`${entry.name}/`, dir))) {
        result.push(module);
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      result.push(new URL(entry.name, dir));
    }
  }

  return result;
}

/** Whether `value` is a class, as opposed to some other function. */
function isClass(value: unknown): value is { prototype: unknown } {
  return (typeof value === "function") &&
    /^class\b/.test(Function.prototype.toString.call(value));
}

/** Each exported class, by module path and export name. */
const EXPORTED_CLASSES: ReadonlyArray<[string, { prototype: unknown }]> =
  await (async () => {
    const found = new Map<unknown, string>();

    for (const url of sourceModulesUnder(SRC_DIR).sort()) {
      // The set of modules is only known once the tree has been walked, so
      // there is no import declaration that could name them.
      const module = await import(url.href);
      const path = url.pathname.slice(SRC_DIR.pathname.length);

      for (const [name, value] of Object.entries(module)) {
        // A class re-exported by a barrel is the same class; it is listed
        // under the first module that exports it.
        if (isClass(value) && !found.has(value)) {
          found.set(value, `${path}: ${name}`);
        }
      }
    }

    return [...found].map(([cls, label]) =>
      [label, cls as { prototype: unknown }] as [string, { prototype: unknown }]
    ).sort(([a], [b]) => (a < b) ? -1 : (a > b) ? 1 : 0);
  })();

describe("frozen classes", () => {
  it("finds exported classes to check", () => {
    // The walk is only evidence if it reaches the classes at all.

    expect(EXPORTED_CLASSES.length).toBeGreaterThan(40);
  });

  for (const [label, cls] of EXPORTED_CLASSES) {
    it(`has a frozen class and prototype for ${label}`, () => {
      expect(Object.isFrozen(cls)).toBe(true);
      expect(Object.isFrozen(cls.prototype)).toBe(true);
    });
  }
});
