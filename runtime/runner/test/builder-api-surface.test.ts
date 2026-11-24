/**
 * The `commonfabric` module a pattern imports has two halves that are written
 * in different packages. Its types are `base/api/index.ts`, handed to the
 * pattern compiler as `types/commonfabric.d.ts`; its values are the object
 * `builder/factory.ts` builds, handed to the sandbox by
 * `sandbox/runtime-modules.ts`. A declaration with no value behind it compiles
 * and then reads as `undefined` when the pattern runs, and a value whose shape
 * has moved away from its declaration is worse: the pattern compiles against a
 * promise the runtime does not keep.
 *
 * `BuilderFunctionsAndConstants` is what stops that, by requiring the built
 * object to carry every value `@commonfabric/api` declares with the declared
 * type. That requirement is enforced by the type checker, so the checks here
 * are of two kinds: `@ts-expect-error` pins that fail the type check if the
 * requirement ever stops rejecting a mismatch, and runtime assertions covering
 * the last step, where the built object is frozen and handed over.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Reactive, WishState } from "@commonfabric/api";
// Imported for the module augmentation it carries as much as for the type: the
// schema-carrying overloads it adds are part of what the pin below calls.
import "@commonfabric/api/schema";
import { createBuilder } from "../src/builder/factory.ts";
import type {
  BuilderFunctionsAndConstants,
  NoStaleDriftingBindings,
  NoStaleIntentionallyUnrequired,
  PatternBuilderSatisfiesDeclaration,
} from "../src/builder/types.ts";
import { getRuntimeModuleExports } from "../src/sandbox/runtime-modules.ts";

/**
 * What the object literal in `builder/factory.ts` is checked against.
 * `__cfHelpers` is left out there too: its value is the object itself, so it is
 * attached once the object exists rather than written in the literal.
 */
type Surface = Omit<BuilderFunctionsAndConstants, "__cfHelpers">;

/** Fails to compile unless `Bound` satisfies `Declared`. */
type Satisfies<Bound extends Declared, Declared> = Bound;

// Each pin below is a mismatch the requirement has to reject. `@ts-expect-error`
// inverts the sense of the line it precedes: the type check fails when the line
// compiles. So a requirement that stopped catching one of these would show up
// here rather than nowhere.
//
// `navigateTo` stands in for the whole surface. Nothing about it is special --
// the requirement is written once, over every name at once, rather than per
// name -- and it has the plainest signature to misstate.

/** A declared name whose binding has gone missing. */
export type MissingBindingIsRejected = Satisfies<
  // @ts-expect-error every value `@commonfabric/api` declares has to be bound
  Omit<Surface, "navigateTo">,
  Surface
>;

/** A binding whose result type has moved away from its declaration. */
export type DriftedBindingIsRejected = Satisfies<
  // @ts-expect-error a binding has to satisfy the type declared for it
  & Omit<Surface, "navigateTo">
  & { navigateTo: (cell: unknown) => string },
  Surface
>;

/**
 * A binding nothing declares, which pattern source could not name and would sit
 * on the surface unreachable. Written as a value because what rejects it is the
 * check on a fresh object literal, which has no type-level equivalent.
 *
 * Never called; the body is here for the type checker to read.
 */
export function undeclaredBindingIsRejected(surface: Surface): Surface {
  return {
    ...surface,
    // @ts-expect-error a binding needs a declaration, or a member of its own
    neitherDeclaredNorExpected: 1,
  };
}

/**
 * `@commonfabric/api/schema` adds schema-carrying overloads to several of the
 * declarations by module augmentation, and those overloads are part of what a
 * binding has to satisfy. This pins the one on `wish` by calling it: an
 * overload set that had lost the second parameter would not accept this call,
 * where a type-level assignment would still hold, since a function of fewer
 * parameters satisfies one that declares more.
 *
 * It does not pin that the augmentation reaches the requirement at all. An
 * augmentation applies across the whole program rather than per module, so this
 * file importing `schema.ts` puts the overloads in scope however
 * `builder/types.ts` is written, and no assertion here can see that import go.
 *
 * Never called; the body is here for the type checker to read.
 */
export function wishTakesASchema(
  wish: Surface["wish"],
): Reactive<WishState<{ note: string }>> {
  return wish(
    { query: "#note" },
    {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    } as const,
  );
}

// The pins above all turn on `navigateTo`, so they say nothing about how far
// the requirement reaches. What decides that is the list of declared names
// `types.ts` exempts, and the assertions it carries beside that list. These
// reach for them, so a name leaving the requirement fails here too rather than
// only where the runner's own type check would report it.
export type NoExemptionOutlivesItsDeclaration = NoStaleIntentionallyUnrequired;
export type ThePatternBindingStillSatisfiesItsDeclaration =
  PatternBuilderSatisfiesDeclaration;
export type NoDriftEntryOutlivesItsReason = NoStaleDriftingBindings;

describe("the commonfabric surface handed to a pattern", () => {
  // Read as plain records: the question is what the objects carry at runtime,
  // which is the one thing their static types cannot answer.
  const built = createBuilder().commonfabric as unknown as Record<
    string,
    unknown
  >;
  const delivered = getRuntimeModuleExports()
    .runtimeExports["commonfabric"] as unknown as Record<string, unknown>;

  // What the sandbox hands over is the built surface after
  // `freezeSandboxValue()`, and the step between the two is where a name could
  // be dropped or the whole object replaced by a wrapper. The type checker sees
  // neither: `runtime-modules.ts` states no type for what it exposes.
  it("hands over the built surface, hardened", () => {
    expect(Object.keys(delivered).sort()).toEqual(Object.keys(built).sort());
    expect(Object.isFrozen(delivered)).toBe(true);
  });

  // `BuilderFunctionsAndConstants` drops the CFC authoring vocabulary whole,
  // because `base/api/index.ts` re-exports those types with `export type *`
  // and TypeScript carries their value meaning into the module's type even
  // though nothing is re-exported at runtime. That subtraction is by name, so
  // it is the one place a real binding could fall out of the requirement
  // unnoticed -- a name that came to be exported by both modules would stop
  // being checked rather than fail. Nothing declares that cannot happen, so it
  // is checked here instead.
  it("keeps no CFC vocabulary name but the one declared as a value", () => {
    const vocabulary = Object.keys(
      getRuntimeModuleExports()
        .runtimeExports["commonfabric/cfc"] as unknown as Record<
          string,
          unknown
        >,
    );
    const bound = vocabulary.filter((name) => name in delivered);

    expect(bound).toEqual(["CFC_CANONICAL_ALIAS_NAMES"]);
  });

  it("points `__cfHelpers` back at the surface itself", () => {
    // The assert-diagnostics transformer emits `__cfHelpers.lift(...)` and the
    // rest against this, so it has to be the same vocabulary a pattern reaches
    // by name.
    expect(delivered.__cfHelpers).toBe(delivered);
  });
});
