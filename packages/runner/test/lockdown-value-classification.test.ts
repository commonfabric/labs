/**
 * Classifies the JS values the data model converts, after SES lockdown has run
 * in this realm, as it has in every realm that evaluates patterns. Lockdown
 * replaces the global `Date` and `RegExp`, and the pattern compartment has a
 * `Date` of its own, so each class is checked as made by host code and as made
 * by pattern code.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type ConvertibleJsValueTag,
  tagOfConvertibleJsValueElseNull,
  VALUE_TAGS,
} from "@commonfabric/data-model";
import {
  FabricEpochNsec,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";

import { createModuleCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";
import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/ses-runtime.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

/** One class the data model converts, and how to make an instance of it. */
interface ConvertibleClass {
  /** The class name, as a test description shows it. */
  readonly name: string;

  /** The tag the data model gives an instance. */
  readonly tag: ConvertibleJsValueTag;

  /** Makes an instance in the host realm. */
  readonly make: () => unknown;

  /** Source of an expression making an instance in a pattern compartment. */
  readonly source: string;
}

const CLASSES: readonly ConvertibleClass[] = [
  {
    name: "Map",
    tag: VALUE_TAGS.JsMap,
    make: () => new Map(),
    source: "new Map()",
  },
  {
    name: "Set",
    tag: VALUE_TAGS.JsSet,
    make: () => new Set(),
    source: "new Set()",
  },
  {
    name: "Date",
    tag: VALUE_TAGS.JsDate,
    make: () => new Date(0),
    source: "new Date(0)",
  },
  {
    name: "Uint8Array",
    tag: VALUE_TAGS.JsUint8Array,
    make: () => new Uint8Array(1),
    source: "new Uint8Array(1)",
  },
  {
    name: "RegExp",
    tag: VALUE_TAGS.JsRegExp,
    make: () => /a/g,
    source: "/a/g",
  },
];

/**
 * Evaluates `source` in a compartment holding the globals a pattern module
 * sees, and returns the value it makes.
 */
function makeInPatternCompartment(source: string): unknown {
  const make = evaluateFunctionSourceInSES(`() => ${source}`, {
    lockdown: true,
    globals: createModuleCompartmentGlobals(),
  });

  return (make as () => unknown)();
}

describe("lockdown-value-classification", () => {
  it("replaces the global `Date` and `RegExp` constructors", () => {
    // The cases below are about a realm in which a prototype's `constructor` is
    // not the global of the same name. This pins that lockdown makes it one.

    ensureSESLockdown();

    expect(Date.prototype.constructor).not.toBe(Date);
    expect(RegExp.prototype.constructor).not.toBe(RegExp);
  });

  describe("a value made by host code", () => {
    for (const { name, tag, make } of CLASSES) {
      it(`returns the \`${tag}\` tag for a \`${name}\``, () => {
        ensureSESLockdown();

        expect(tagOfConvertibleJsValueElseNull(make())).toBe(tag);
      });
    }
  });

  describe("a value made by pattern code", () => {
    for (const { name, tag, source } of CLASSES) {
      it(`returns the \`${tag}\` tag for a \`${name}\``, () => {
        ensureSESLockdown();

        expect(tagOfConvertibleJsValueElseNull(
          makeInPatternCompartment(source),
        )).toBe(tag);
      });
    }
  });

  describe("a pattern handler", () => {
    it("stores the fabric forms of a `Date` and a `RegExp` it writes", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });

      try {
        const { main } = await runtime.harness.compileAndEvaluateModules({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: [
              'import { type Cell, handler, pattern } from "commonfabric";',
              "const record = handler(",
              "  (_: unknown, state: { when: Cell<Date>; match: Cell<RegExp> }) => {",
              "    state.when.set(new Date(1000));",
              "    state.match.set(/a/g);",
              "  },",
              ");",
              "export default pattern<{ when: Date; match: RegExp }>(",
              "  ({ when, match }) => ({",
              "    when,",
              "    match,",
              "    record: record({ when, match }),",
              "  }),",
              ");",
            ].join("\n"),
          }],
        });
        const errors: Error[] = [];
        runtime.scheduler.onError((error: Error) => {
          errors.push(error);
        });
        const resultCell = runtime.getCell(
          signer.did(),
          "lockdown-value-classification-handler",
        );
        await runtime.setup(
          undefined,
          main!.default,
          { when: null, match: null },
          resultCell,
        );
        runtime.start(resultCell);
        await resultCell.pull();

        resultCell.key("record").send({});
        await runtime.scheduler.idle();

        expect(errors.map((error) => error.message)).toEqual([]);
        const when = resultCell.key("when").get();
        expect(when).toBeInstanceOf(FabricEpochNsec);
        expect((when as FabricEpochNsec).value).toBe(1_000_000_000n);
        const match = resultCell.key("match").get();
        expect(match).toBeInstanceOf(FabricRegExp);
        expect((match as FabricRegExp).source).toBe("a");
        expect((match as FabricRegExp).flags).toBe("g");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });
});
