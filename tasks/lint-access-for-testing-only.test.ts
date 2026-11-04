/// <reference lib="deno.unstable" />

/**
 * Runs the `cf-source/no-access-for-testing-only` rule over short files and
 * checks what it reports. `Deno.lint.runPlugin` takes the file name, which is
 * what puts a case in or out of the rule's scope.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, resolve } from "@std/path";
import plugin from "./lint-access-for-testing-only.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** A source file's name, which puts every case in scope unless it says. */
const SOURCE = "runtime/fryer/src/fryer.ts";

/** Lints `source` as the file at `fileName`, returning the messages. */
function diagnose(source: string, fileName = SOURCE): string[] {
  return Deno.lint.runPlugin(plugin, fileName, source).map((d) => d.message);
}

/** Distinguishing phrase of the rule's one message. */
const REPORTED = "only a test, a benchmark, or a file serving one may read it";

/** A class declaring the getter both ways, with an instance to reach. */
const DECLARATION = `
  class Fryer {
    #temperature = 190;
    get accessForTestingOnly(): { readonly temperature: number } {
      return { temperature: this.#temperature };
    }
    static get accessForTestingOnly(): { readonly count: number } {
      return { count: 1 };
    }
  }
  const fryer = new Fryer();
`;

describe("lint-access-for-testing-only", () => {
  it("reports a dot access", () => {
    const messages = diagnose(`
      ${DECLARATION}
      fryer.accessForTestingOnly.temperature;
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(REPORTED);
  });

  it("reports an access on the class", () => {
    expect(
      diagnose(`
      ${DECLARATION}
      Fryer.accessForTestingOnly.count;
    `).length,
    ).toBe(1);
  });

  it("reports an optional-chain access", () => {
    expect(
      diagnose(`
      ${DECLARATION}
      fryer?.accessForTestingOnly?.temperature;
    `).length,
    ).toBe(1);
  });

  it("reports a bracket access with the name as a string", () => {
    expect(
      diagnose(`
      ${DECLARATION}
      fryer["accessForTestingOnly"].temperature;
    `).length,
    ).toBe(1);
  });

  it("reports a destructuring of the name, plain and renamed", () => {
    expect(
      diagnose(`
      ${DECLARATION}
      const { accessForTestingOnly } = fryer;
    `).length,
    ).toBe(1);
    expect(
      diagnose(`
      ${DECLARATION}
      const { accessForTestingOnly: internals } = fryer;
    `).length,
    ).toBe(1);
    expect(
      diagnose(`
      ${DECLARATION}
      const { "accessForTestingOnly": internals } = fryer;
    `).length,
    ).toBe(1);
  });

  it("reports the declaring class reading its own getter", () => {
    expect(
      diagnose(`
      class Fryer {
        #temperature = 190;
        get accessForTestingOnly(): { readonly temperature: number } {
          return { temperature: this.#temperature };
        }
        fry(): number {
          return this.accessForTestingOnly.temperature;
        }
      }
    `).length,
    ).toBe(1);
  });

  it("reports each access in a file once", () => {
    expect(
      diagnose(`
      ${DECLARATION}
      fryer.accessForTestingOnly.temperature;
      Fryer.accessForTestingOnly.count;
    `).length,
    ).toBe(2);
  });

  it("returns nothing for the getter's declaration", () => {
    expect(diagnose(DECLARATION)).toEqual([]);
  });

  it("returns nothing for an object literal with a property of the name", () => {
    expect(diagnose(`
      const shape = { accessForTestingOnly: { temperature: 190 } };
    `)).toEqual([]);
  });

  it("returns nothing for a type naming the getter", () => {
    expect(diagnose(`
      ${DECLARATION}
      type Internals = Fryer["accessForTestingOnly"];
    `)).toEqual([]);
  });

  it("returns nothing for a computed access through a variable", () => {
    expect(diagnose(`
      ${DECLARATION}
      const accessForTestingOnly = "temperature";
      fryer[accessForTestingOnly];
    `)).toEqual([]);
  });

  it("returns nothing for another member of a similar name", () => {
    expect(diagnose(`
      ${DECLARATION}
      fryer.accessForTesting;
      fryer.accessForTestingOnlyLater;
    `)).toEqual([]);
  });

  it("returns nothing in a test, a benchmark, or a file serving one", () => {
    const access = `
      ${DECLARATION}
      fryer.accessForTestingOnly.temperature;
    `;
    for (
      const fileName of [
        "runtime/fryer/test/fryer.test.ts",
        "runtime/fryer/fryer.test.ts",
        "runtime/fryer/src/fryer.test.tsx",
        "runtime/fryer/bench/fryer.bench.ts",
        "runtime/fryer/test/helper.ts",
        "runtime/fryer/integration/harness.ts",
        "runtime/fryer/bench/fixtures/far-side.ts",
      ]
    ) {
      expect(diagnose(access, fileName)).toEqual([]);
    }
  });

  it("reads an absolute path relative to the repository root", () => {
    const access = `
      ${DECLARATION}
      fryer.accessForTestingOnly.temperature;
    `;
    expect(diagnose(access, resolve(REPO_ROOT, SOURCE)).length).toBe(1);
    expect(diagnose(access, resolve(REPO_ROOT, "runtime/fryer/test/x.ts")))
      .toEqual([]);
  });
});
