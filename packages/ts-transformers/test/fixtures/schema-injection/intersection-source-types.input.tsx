import { type OpaqueCell, toSchema } from "commonfabric";

// FIXTURE: intersection-source-types
// Verifies: intersections retain source type distinctions through schema
// generation. Opaque cells and `void` have different intersection behavior;
// nested and named branded primitives retain their primitive constraints.
// Expected: each call becomes the checker's `true` or `false` schema.

type Brand = string & { topic: unknown };
type Folded = (string & { a: 1 }) | (number & { b: 2 });
type OpaqueCompatible = any & OpaqueCell<any> & string & unknown;
export const validOpaque: OpaqueCompatible = 123;

export const opaqueCompatible = toSchema<
  any & OpaqueCell<any> & string & unknown
>();
export const opaqueImpossible = toSchema<
  any & OpaqueCell<any> & undefined & unknown
>();
export const voidCompatible = toSchema<any & void & undefined & unknown>();
export const voidImpossible = toSchema<any & void & string & unknown>();
export const distinctSources = toSchema<
  any & OpaqueCell<any> & void & undefined & unknown
>();
export const unionSources = toSchema<
  any & (OpaqueCell<any> | void) & string & unknown
>();
export const nestedImpossible = toSchema<
  any & (string & { topic: unknown }) & number
>();
export const namedImpossible = toSchema<any & Brand & number & unknown>();
export const nestedWithoutAny = toSchema<
  (string & { topic: unknown }) & number
>();
export const nestedCompatible = toSchema<
  any & (string & { topic: unknown }) & string
>();
export const reducedInnerAny = toSchema<(any & null) & string & unknown>();
export const distributedBrand = toSchema<(Brand | number) & boolean & unknown>();
export const unionBesideAny = toSchema<
  any & (Brand | number) & boolean & unknown
>();
export const foldedUnionBesideAny = toSchema<any & Folded & number>();
export const foldedUnion = toSchema<Folded & number>();
