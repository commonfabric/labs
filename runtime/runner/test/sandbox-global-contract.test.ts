import { assertEquals } from "@std/assert";
import { assets, StaticCache } from "@commonfabric/static";
import { SANDBOX_WITHHELD_GLOBALS } from "@commonfabric/utils/sandbox-contract";
import { createCallbackCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";
import { ensureSESLockdown } from "../src/sandbox/ses-runtime.ts";

/**
 * The pattern compiler type checks authored code against the type libraries in
 * `base/static/assets/types`, and the runtime then evaluates that code in a
 * SES compartment. The two have to agree about which globals exist. When they
 * disagree in the direction of the compiler promising more, a pattern type
 * checks, compiles and deploys, and then throws a `TypeError` in the user's
 * hands — every gate passes and the failure lands where it costs the most.
 *
 * The libraries are read from the same asset cache the compiler reads, and the
 * globals are the ones the runtime really installs, so neither side can drift
 * without failing these tests.
 */

/**
 * Every type asset the compiler can serve, rather than just the two that bind
 * globals today, so a library added later is covered without touching this
 * file. The others contribute nothing: a module's declarations are not globals,
 * and a `declare var` nested inside one is indented and so does not match.
 */
const TYPE_ASSETS = assets.filter((asset) => asset.startsWith("types/"));

/**
 * Names a library binds in the global scope. A type library binds a value
 * three ways, and checking only the first is how `setTimeout` and `Intl` stayed
 * promised-and-absent behind a test that claimed to cover them:
 *
 * - `declare var X: ...;`, the constructors and namespace objects
 * - `declare function X(...): ...;`, the free functions such as `setTimeout`
 * - `declare namespace X { ... }`, where `Intl` hangs its members
 *
 * `declare type`/`interface`/`declare namespace` holding only types bind no
 * value, so a namespace counts only when it declares one. The `^` anchor keeps
 * a namespace's indented members from matching on their own.
 */
function declaredGlobals(libText: string): string[] {
  const names = [
    ...libText.matchAll(/^declare (?:var|function) ([A-Za-z_$][\w$]*)/gm),
  ].map((match) => match[1]);

  for (
    const match of libText.matchAll(/^declare namespace ([A-Za-z_$][\w$]*)/gm)
  ) {
    if (declaresValueMember(libText, match.index + match[0].length)) {
      names.push(match[1]);
    }
  }
  return names;
}

/** True when the namespace body starting at `start` declares a value. */
function declaresValueMember(libText: string, start: number): boolean {
  const open = libText.indexOf("{", start);
  if (open === -1) return false;

  let depth = 0;
  for (let index = open; index < libText.length; index += 1) {
    if (libText[index] === "{") depth += 1;
    else if (libText[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = libText.slice(open + 1, index);
        return /^\s*(?:var|function|const|let|class|enum)\s/m.test(body);
      }
    }
  }
  return false;
}

async function compilerDeclaredGlobals(): Promise<string[]> {
  const cache = StaticCache.fromFileSystem();
  const perFile = await Promise.all(
    TYPE_ASSETS.map(async (file) => declaredGlobals(await cache.getText(file))),
  );
  return [...new Set(perFile.flat())].sort();
}

let compartment: { evaluate(source: string): unknown } | undefined;

function evaluateInCompartment(source: string): unknown {
  if (!compartment) {
    ensureSESLockdown();
    const Compartment = (globalThis as {
      Compartment?: new (globals?: Record<string, unknown>) => {
        evaluate(source: string): unknown;
      };
    }).Compartment;
    if (!Compartment) throw new Error("SES Compartment is unavailable");
    compartment = new Compartment(createCallbackCompartmentGlobals());
  }
  return compartment.evaluate(source);
}

function definedInCompartment(name: string): boolean {
  return evaluateInCompartment(`typeof globalThis.${name}`) !== "undefined";
}

Deno.test("the compiler declares no global the sandbox lacks", async () => {
  const declared = await compilerDeclaredGlobals();
  // Guard against the matcher finding nothing and the test passing vacuously.
  // `JSON` is a `declare var`, `atob` a `declare function`, and `Reflect` a
  // `declare namespace` holding values, so all three forms are covered.
  for (const name of ["JSON", "atob", "Reflect"]) {
    assertEquals(declared.includes(name), true, `expected to detect ${name}`);
  }

  const gaps = declared.filter((name) => !definedInCompartment(name)).sort();

  assertEquals(
    gaps,
    [],
    "The compiler declares these globals but the sandbox does not provide " +
      "them. Each is a live bug: a pattern using one compiles and then throws " +
      "at runtime. Resolve each by either endowing it in " +
      "compartment-globals.ts, or adding it to SANDBOX_WITHHELD_GLOBALS and " +
      "running `deno task strip-withheld-globals` in base/static.",
  );
});

Deno.test("no withheld global is declared by the compiler", async () => {
  const declared = new Set(await compilerDeclaredGlobals());
  const stillDeclared = SANDBOX_WITHHELD_GLOBALS.filter((name) =>
    declared.has(name)
  );

  assertEquals(
    stillDeclared,
    [],
    "These globals are on SANDBOX_WITHHELD_GLOBALS but the type libraries " +
      "still declare them. Run `deno task strip-withheld-globals` in " +
      "base/static.",
  );
});

Deno.test("every withheld global is really absent from a compartment", () => {
  // A withheld name that is present is a stale entry: the type libraries are
  // hiding a global the sandbox would have been happy to provide.
  const withheldButPresent = SANDBOX_WITHHELD_GLOBALS.filter((name) =>
    definedInCompartment(name)
  );

  assertEquals(
    withheldButPresent,
    [],
    "These globals are on SANDBOX_WITHHELD_GLOBALS but a compartment provides " +
      "them. Drop them from the list and restore their declarations.",
  );
});

Deno.test("the NaN side channel stays closed inside a compartment", () => {
  // `Float32Array`/`Float64Array` are withheld because a NaN's spare mantissa
  // bits can carry a payload. Reading bytes as a float still mints such a NaN,
  // but writing one back out is what completes the channel, and lockdown
  // repairs `DataView.prototype.setFloat*` to write only canonical NaNs. No
  // comparable repair exists for a float typed-array element store, which is
  // why the constructors stay out rather than being endowed.
  const recovered = evaluateInCompartment(`
    const view = new DataView(new ArrayBuffer(8));

    // 64-bit: mint a NaN carrying 0xdead, then try to read the bits back.
    const PAYLOAD64 = 0x7ff8_0000_0000_deadn;
    view.setBigUint64(0, PAYLOAD64, true);
    const smuggled64 = view.getFloat64(0, true);
    if (!Number.isNaN(smuggled64)) throw new Error("expected a NaN");
    view.setBigUint64(0, 0n, true);
    view.setFloat64(0, smuggled64, true);
    const recovered64 = view.getBigUint64(0, true) === PAYLOAD64;

    // 32-bit: same shape, through setFloat32.
    const PAYLOAD32 = 0x7fc0_dead;
    view.setUint32(0, PAYLOAD32, true);
    const smuggled32 = view.getFloat32(0, true);
    if (!Number.isNaN(smuggled32)) throw new Error("expected a NaN");
    view.setUint32(0, 0, true);
    view.setFloat32(0, smuggled32, true);
    const recovered32 = view.getUint32(0, true) === PAYLOAD32;

    ({ recovered64, recovered32 });
  `);

  assertEquals(recovered, { recovered64: false, recovered32: false });
});
