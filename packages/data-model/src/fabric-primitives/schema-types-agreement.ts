/**
 * Compile-time agreement between the set of concrete primitive classes in
 * `impl.ts` and what `api.ts` declares of them. Against
 * `FabricPrimitiveSchemaType`: a class for every name in the vocabulary, a
 * name in the vocabulary for every class, and no name reported by two classes.
 * Against the declarations by name: each class keyed by the name `api.ts`
 * declares it under, and the runtime vocabulary and its predicate typed as
 * declared. No module imports this one: it exists to be type-checked, which
 * `deno check` does for every module under the package whether or not
 * something imports it, and everything here erases at compile time.
 *
 * Of the vocabulary's three, the first two are one comparison of two unions,
 * which cannot see a name reported twice: two classes reporting one name add a
 * single member to the union between them. The third comparison is what
 * catches that, and it is what makes `fabricPrimitiveClassOfSchemaType()` a
 * function of the name. It tells two classes apart by assignability, so two
 * that are mutually assignable read as one. A class holding a `#private`
 * member is assignable to no other, which covers every class with state.
 */

import type { IsUnion, MustBeTrue, Same } from "@commonfabric/utils/types";

import type * as Api from "@/api.ts";

import type {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  FabricPrimitiveClass,
  FabricPrimitiveClassesByName,
  isFabricPrimitiveSchemaType,
} from "./impl.ts";

/** The members of `Classes` whose instances report `Name`. */
type ClassesReporting<Classes, Name> = Extract<
  Classes,
  { readonly prototype: { readonly schemaType: Name } }
>;

/**
 * Whether some name among `Names` is reported by more than one member of
 * `Classes`: `false` when none is, and `boolean` or `true` when one is.
 */
export type ReportsSharedName<Classes, Names extends string> = {
  [Name in Names]: IsUnion<ClassesReporting<Classes, Name>>;
}[Names];

/** The declared `prototype` of `Class`, or `never` when it declares none. */
type PrototypeOf<Class> = Class extends { readonly prototype: infer P } ? P
  : never;

/**
 * Whether the instances of every class in `ByName` satisfy the instance type
 * of what `Declared` holds under the same name: `true` when all do, and
 * `boolean` or `false` when one does not, a name `Declared` lacks among them.
 */
export type NamedClassesSatisfy<ByName, Declared> = {
  [Name in keyof ByName]: Name extends keyof Declared
    ? ([PrototypeOf<Declared[Name]>] extends [never] ? false
      : PrototypeOf<ByName[Name]> extends PrototypeOf<Declared[Name]> ? true
      : false)
    : false;
}[keyof ByName];

/** Whether the names the classes report are exactly the vocabulary. */
export type SchemaTypesAgree = MustBeTrue<
  Same<
    FabricPrimitiveClass["prototype"]["schemaType"],
    Api.FabricPrimitiveSchemaType
  >
>;

/** Whether each name in the vocabulary is reported by one class only. */
export type SchemaTypesDistinct = MustBeTrue<
  Same<
    ReportsSharedName<FabricPrimitiveClass, Api.FabricPrimitiveSchemaType>,
    false
  >
>;

/** Whether each class is keyed by the name `api.ts` declares it under. */
// The instance side only. A constructor taking a class with a `#private`
// member is one nothing structural satisfies, so the constructor side is
// asserted by each class beside its own definition.
export type ClassNamesAgree = MustBeTrue<
  Same<NamedClassesSatisfy<FabricPrimitiveClassesByName, typeof Api>, true>
>;

/** Whether the runtime vocabulary agrees with its declaration. */
export type VocabularyAgrees = MustBeTrue<
  Same<
    typeof FABRIC_PRIMITIVE_SCHEMA_TYPES,
    typeof Api.FABRIC_PRIMITIVE_SCHEMA_TYPES
  >
>;

/** Whether the vocabulary's predicate agrees with its declaration. */
export type PredicateAgrees = MustBeTrue<
  Same<
    typeof isFabricPrimitiveSchemaType,
    typeof Api.isFabricPrimitiveSchemaType
  >
>;
