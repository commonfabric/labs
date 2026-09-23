/**
 * What `Schema` infers from a `FabricPrimitive` name in a schema's `type`.
 * The assertions are made when this file is type-checked (`tasks/check.sh`
 * runs `deno check` over `packages/api`), not when it runs: the package's
 * `test` task passes `--no-check`. Nothing here names the full set of classes.
 * The cases that range over it do so through `ConcreteFabricPrimitive` and
 * `FabricPrimitiveSchemaType`, so a class added to the data model is covered
 * without an edit here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  ConcreteFabricPrimitive,
  FabricBytes,
  FabricHash,
  FabricPrimitiveSchemaType,
} from "@commonfabric/api";
import type { Schema } from "@commonfabric/api/schema";
import type { Equal, MustBeTrue } from "@commonfabric/utils/types";

/** The inference for each name in the vocabulary, keyed by the name. */
type InferredByName = {
  [Name in FabricPrimitiveSchemaType]: Schema<{ readonly type: Name }>;
};

/** The name `T` reports as `.schemaType`, or `never` when it reports none. */
type SchemaTypeOf<T> = T extends { readonly schemaType: infer Name } ? Name
  : never;

/** Holder of the compile-time claims, never called. */
function schemaFabricPrimitiveTypeChecks() {
  // Each claim is a type alias `MustBeTrue` refuses unless it is `true`.
  // `Equal` and not `Same`, so that an inference of `any` does not pass.

  type _OneName = MustBeTrue<
    Equal<Schema<{ readonly type: "FabricBytes" }>, FabricBytes>
  >;
  type _AnotherName = MustBeTrue<
    Equal<Schema<{ readonly type: "FabricHash" }>, FabricHash>
  >;

  // Every name infers an interface reporting that name, and between them the
  // names infer every concrete interface.
  type _EachReportsItsName = MustBeTrue<
    Equal<
      {
        [Name in FabricPrimitiveSchemaType]: SchemaTypeOf<InferredByName[Name]>;
      },
      { [Name in FabricPrimitiveSchemaType]: Name }
    >
  >;
  type _AllCovered = MustBeTrue<
    Equal<InferredByName[FabricPrimitiveSchemaType], ConcreteFabricPrimitive>
  >;

  // A `type` naming two classes infers the union of the two.
  type _TwoNames = MustBeTrue<
    Equal<
      Schema<{ readonly type: "FabricBytes" | "FabricHash" }>,
      FabricBytes | FabricHash
    >
  >;

  // The standard vocabulary is untouched by the `FabricPrimitive` arm.
  type _String = MustBeTrue<Equal<Schema<{ readonly type: "string" }>, string>>;
  type _Null = MustBeTrue<Equal<Schema<{ readonly type: "null" }>, null>>;
}

describe("schema-fabric-primitive-types", () => {
  it("type-checks what `Schema` infers from a `FabricPrimitive` type name", () => {
    // The claims are enforced by the type-checker; at run time only the
    // function holding them is observable.

    expect(typeof schemaFabricPrimitiveTypeChecks).toBe("function");
  });
});
