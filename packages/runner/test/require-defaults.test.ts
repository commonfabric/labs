/**
 * Type-level tests for RequireDefaults<T> and related utilities.
 *
 * These tests verify compile-time behavior of RequireDefaults<T>,
 * StripDefaultBrand<T>, and the Default<T,V> brand detection logic.
 * If any type assertion is wrong, this file will fail to compile.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { DeepDefault, Default } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import type { MustBeTrue } from "@commonfabric/utils/types";

import type {
  RequireDefaults,
  StripDefaultBrand,
} from "../src/builder/types.ts";

//
// Helpers
//

/**
 * Asserts T and U are mutually assignable (structurally equal).
 * Produces `never` on mismatch → compile error at call site.
 */
type AssertEqual<T, U> = [T] extends [U] ? [U] extends [T] ? true : never
  : never;

/**
 * Flattens an intersection type to a plain object type so that
 * AssertEqual works correctly with RequireDefaults<T> (which is an
 * intersection of two mapped types).
 */
type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * Asserts T and U are NOT mutually assignable.
 * Produces `never` if they ARE equal → compile error at call site.
 */
type AssertNotEqual<T, U> = [T] extends [U] ? [U] extends [T] ? never : true
  : true;

//
// StripDefaultBrand<T> — non-Default types are unchanged
//

const _stripPlainString: MustBeTrue<
  AssertEqual<StripDefaultBrand<string>, string>
> = true;

const _stripPlainNumber: MustBeTrue<
  AssertEqual<StripDefaultBrand<number>, number>
> = true;

const _stripPlainObject: MustBeTrue<
  AssertEqual<StripDefaultBrand<{ a: string }>, { a: string }>
> = true;

//
// StripDefaultBrand<T> — Default<T,V> strips to plain T
//

const _stripDefaultString: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<string, "hello">>, string>
> = true;

const _stripDefaultNumber: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<number, 0>>, number>
> = true;

const _stripDefaultBoolean: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<boolean, true>>, boolean>
> = true;

const _stripDefaultNull: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<null>>, null>
> = true;

const _stripUnionDefaultNull: MustBeTrue<
  AssertEqual<StripDefaultBrand<string | Default<null>>, string | null>
> = true;

// Default<T|undefined, V> strips to T|undefined (brand removed, undefined kept)
const _stripDefaultWithUndefined: MustBeTrue<
  AssertEqual<
    StripDefaultBrand<Default<string | undefined, "x">>,
    string | undefined
  >
> = true;

//
// RequireDefaults<T> — plain optional fields are unchanged
//

const _plainOptionalPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ name?: string }>>,
    { name?: string | undefined }
  >
> = true;

const _plainRequiredPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ name: string }>>,
    { name: string }
  >
> = true;

//
// RequireDefaults<T> — Default<> fields become required with brand stripped
//

const _stringDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ title?: Default<string, "Untitled"> }>>,
    { title: string }
  >
> = true;

const _numberDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ count?: Default<number, 0> }>>,
    { count: number }
  >
> = true;

const _booleanDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ enabled?: Default<boolean, false> }>>,
    { enabled: boolean }
  >
> = true;

const _objectDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ options?: Default<{ x: number }, { x: 0 }> }>>,
    { options: { x: number } }
  >
> = true;

//
// RequireDefaults<T> — mixed: Default fields required, plain fields preserved
//

type Mixed = {
  title?: Default<string, "Untitled">;
  count?: Default<number, 0>;
  name?: string;
  id: number;
};

const _mixed: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<Mixed>>,
    { title: string; count: number; name?: string | undefined; id: number }
  >
> = true;

//
// RequireDefaults<T> — Default<T|undefined, V>
//
// The implementation strips `| undefined` via Exclude when making the key
// required, so the value type becomes just T (not T|undefined).
//

const _undefinableDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ tag?: Default<string | undefined, ""> }>>,
    { tag: string }
  >
> = true;

//
// RequireDefaults<T> — Cell-wrapped Default fields
//

const _cellDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: Default<Cell<string[]>, never> }>>,
    { items: Cell<string[]> }
  >
> = true;

//
// RequireDefaults<T> — Default field in a union with a plain type
//
// The presence of a Default-branded member in the union makes the field required.
//

const _unionDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: Default<string, "x"> | number }>>,
    { value: string | number }
  >
> = true;

const _unionNullDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: string | Default<null> }>>,
    { value: string | null }
  >
> = true;

const _cellUnionNullDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: Cell<string | Default<null>> }>>,
    { value: Cell<string | null> }
  >
> = true;

const _arrayUnionEmptyDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: string[] | Default<[]> }>>,
    { items: string[] }
  >
> = true;

const _cellArrayUnionEmptyDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: Cell<string[] | Default<[]>> }>>,
    { items: Cell<string[]> }
  >
> = true;

const _nullDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: Default<null> }>>,
    { value: null }
  >
> = true;

type DeepDefaultConfig = {
  theme: string;
  retries: number;
};

const _deepDefaultUnion: MustBeTrue<
  AssertEqual<
    Simplify<
      RequireDefaults<
        { config?: DeepDefaultConfig | DeepDefault<{ theme: "dark" }> }
      >
    >,
    { config: DeepDefaultConfig }
  >
> = true;

//
// RequireDefaults<T> — plain union (no Default) stays optional
//

const _plainUnionPreserved: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ value?: string | number }>>,
    { value?: string | number | undefined }
  >
> = true;

//
// RequireDefaults<T> — is only one level deep (inner Default fields are not
// processed, preserving the Default brand on nested types)
//

type Nested = {
  outer?: Default<string, "">;
  inner: { a?: Default<number, 0> };
};

const _shallowOnly: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<Nested>>,
    // `outer` is made required; `inner` is untouched (Default brand preserved inside)
    { outer: string; inner: { a?: Default<number, 0> } }
  >
> = true;

//
// StripDefaultBrand<T> — any, never, unknown pass through unchanged
//

const _stripAny: MustBeTrue<AssertEqual<StripDefaultBrand<any>, any>> = true;
const _stripNever: MustBeTrue<AssertEqual<StripDefaultBrand<never>, never>> =
  true;
const _stripUnknown: MustBeTrue<
  AssertEqual<StripDefaultBrand<unknown>, unknown>
> = true;

//
// StripDefaultBrand<T> — array and tuple types
//

// Plain array is unchanged
const _stripPlainArrayType: MustBeTrue<
  AssertEqual<StripDefaultBrand<string[]>, string[]>
> = true;

// Default<string[], []> strips to string[]
const _stripDefaultArrayType: MustBeTrue<
  AssertEqual<StripDefaultBrand<Default<string[], []>>, string[]>
> = true;

// Default<[string, number], ["a", 0]> strips to the tuple type
const _stripDefaultTuple: MustBeTrue<
  AssertEqual<
    StripDefaultBrand<Default<[string, number], ["a", 0]>>,
    [string, number]
  >
> = true;

// The documented `T[] | Default<[]>` shape strips to exactly `T[]`, NOT
// `T[] | never[]`. `Default<[]>` keeps only its branded arm, so the bare
// empty-tuple member never enters the union and the sibling `T[]` supplies the
// value type.
const _stripArrayUnionEmptyDefault: MustBeTrue<
  AssertEqual<StripDefaultBrand<string[] | Default<[]>>, string[]>
> = true;

// Consequence: parameter-position array methods keep the element type (not
// `never`). The body is type-checked but never executed (these are static
// assertions; the `declare`d binding has no runtime value).
function _ct1640ParamPositionMethods(
  ids: StripDefaultBrand<string[] | Default<[]>>,
): void {
  const _includes: boolean = ids.includes("a");
  const _indexOf: number = ids.indexOf("a");
  void _includes;
  void _indexOf;
}
void _ct1640ParamPositionMethods;

// The Default<[]> brand must still be detectable, so RequireDefaults<> makes
// the field required (this is why we keep the branded arm rather than dropping
// Default<[]> entirely).
const _emptyArrayUnionDefaultRequired: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: string[] | Default<[]> }>>,
    { items: string[] }
  >
> = true;

//
// StripDefaultBrand<T> — Default<T & U, V> intersection
//

type IntersectedT = { a: string } & { b: number };

const _stripDefaultIntersection: MustBeTrue<
  AssertEqual<
    StripDefaultBrand<Default<IntersectedT, { a: "x"; b: 0 }>>,
    IntersectedT
  >
> = true;

//
// RequireDefaults<T> — any, never, unknown
//

// any absorbs all intersections: RequireDefaults<any> = any
const _requireDefaultsAny: MustBeTrue<
  AssertEqual<RequireDefaults<any>, any>
> = true;

// A field typed as `never` has no Default brand; it is preserved as-is
const _neverFieldPreserved: MustBeTrue<
  AssertEqual<Simplify<RequireDefaults<{ x: never }>>, { x: never }>
> = true;

// keyof unknown = never → RequireDefaults<unknown> has no keys
const _requireDefaultsUnknownHasNoKeys: MustBeTrue<
  AssertEqual<keyof Simplify<RequireDefaults<unknown>>, never>
> = true;

//
// RequireDefaults<T> — empty object
//

// RequireDefaults on an empty object produces a type with no keys
// (uses `Record<never, never>` to avoid the `ban-types` lint rule for literal `{}`)
type _EmptySchema = Record<never, never>;
const _emptyObjectHasNoKeys: MustBeTrue<
  AssertEqual<keyof Simplify<RequireDefaults<_EmptySchema>>, never>
> = true;

//
// RequireDefaults<T> — array and tuple types as Default fields
//

const _arrayDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ items?: Default<string[], []> }>>,
    { items: string[] }
  >
> = true;

const _tupleDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ pair?: Default<[string, number], ["a", 0]> }>>,
    { pair: [string, number] }
  >
> = true;

//
// RequireDefaults<T> — index signatures
//

// Plain index signature is preserved unchanged
const _plainIndexSig: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ [key: string]: string }>>,
    { [key: string]: string }
  >
> = true;

// Default-branded index signature has brand stripped to plain value type
const _defaultIndexSig: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ [key: string]: Default<string, ""> }>>,
    { [key: string]: string }
  >
> = true;

//
// RequireDefaults<T> — Default<T & U, V> intersection field
//

const _intersectionDefault: MustBeTrue<
  AssertEqual<
    Simplify<RequireDefaults<{ x?: Default<IntersectedT, { a: "x"; b: 0 }> }>>,
    { x: IntersectedT }
  >
> = true;

//
// RequireDefaults<T> — Default in generic context
//

// RequireDefaults works correctly when used inside a generic type alias
type ApplyRequireDefaults<T extends object> = Simplify<RequireDefaults<T>>;

const _genericContext: MustBeTrue<
  AssertEqual<
    ApplyRequireDefaults<{ name?: Default<string, "">; id: number }>,
    { name: string; id: number }
  >
> = true;

//
// RequireDefaults<T> — `any` fields are not treated as Default-branded
//

// IsDefaultField<any> = false (IsAny guard), so `any` fields remain unchanged.
// RequireDefaults must not make an `any`-typed field required.
// Note: we can't assert the full shape with `any` since `any` swallows
// structural equality — instead we verify the key remains optional.
type _AnyFieldResult = Simplify<RequireDefaults<{ x?: any }>>;
const _anyFieldOptional: MustBeTrue<
  AssertEqual<undefined extends _AnyFieldResult["x"] ? true : false, true>
> = true;

//
// Negative tests — things that must NOT happen
//

// Plain optional field must NOT be made required
const _plainOptionalNotRequired: MustBeTrue<
  AssertNotEqual<
    Simplify<RequireDefaults<{ name?: string }>>,
    { name: string }
  >
> = true;

// Default-branded field must NOT remain optional after RequireDefaults
const _defaultFieldNotOptional: MustBeTrue<
  AssertNotEqual<
    Simplify<RequireDefaults<{ name?: Default<string, ""> }>>,
    { name?: string }
  >
> = true;

// StripDefaultBrand must NOT erase a Default<> type to never
const _stripDefaultNotNever: MustBeTrue<
  AssertNotEqual<StripDefaultBrand<Default<string, "hello">>, never>
> = true;

// StripDefaultBrand must NOT erase a plain type to never
const _stripPlainNotNever: MustBeTrue<
  AssertNotEqual<StripDefaultBrand<string>, never>
> = true;

//
// Runtime stub — the type assertions above are the real tests
//

describe("RequireDefaults type-level tests", () => {
  it("all type assertions compile correctly", () => {
    // If this file compiled without errors, all static type assertions passed.
    expect(true).toBe(true);
  });
});
