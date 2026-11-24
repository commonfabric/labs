import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricInstancePlus, FabricValue } from "@commonfabric/data-model";

import type { CellHandle, ClientCellValue } from "../src/cell-handle.ts";

// The assertions in this file are made when it is type-checked, which the
// repository's type check does for this directory, not when it runs. The
// carrier below is a function that is never called: an assignment in it that
// must type-check pins a direction the type admits, and a `@ts-expect-error`
// marks one it must refuse -- if the refusal regresses, the directive becomes
// unused and the type check fails on it.

/**
 * The recursive shape `ClientCellValue` names, written out: a `FabricValue`,
 * a `CellHandle`, or a read-only tree of either.
 */
type WrittenOutClientCellValue =
  | FabricValue
  | CellHandle<unknown>
  | readonly WrittenOutClientCellValue[]
  | { readonly [key: string]: WrittenOutClientCellValue };

declare const writtenOut: WrittenOutClientCellValue;
declare const clientValue: ClientCellValue;
declare const plusInstance: FabricInstancePlus<CellHandle<unknown>>;
declare const handle: CellHandle<unknown>;
declare const handleArray: readonly CellHandle<unknown>[];
declare const handleRecord: { readonly [key: string]: CellHandle<unknown> };

/** Carrier for the `ClientCellValue` checks. */
function clientCellValueTypeChecks() {
  // The written-out recursion is admitted, and so is a handle at the top and
  // inside each container.
  const fromWrittenOut: ClientCellValue = writtenOut;
  const bare: ClientCellValue = handle;
  const inArray: ClientCellValue = handleArray;
  const inRecord: ClientCellValue = handleRecord;

  // The alias is wider than the written-out recursion by one arm: an instance
  // whose contents may hold a handle, which the alias admits and the
  // written-out recursion does not. `CellHandle.serialize()` refuses every
  // instance on the way out, so the arm is admitted here and refused there.
  const instanceArm: ClientCellValue = plusInstance;
  // @ts-expect-error a `FabricInstancePlus<CellHandle<unknown>>` is admitted only by the alias
  const toWrittenOut: WrittenOutClientCellValue = clientValue;

  return {
    fromWrittenOut,
    bare,
    inArray,
    inRecord,
    instanceArm,
    toWrittenOut,
  };
}

describe("ClientCellValue", () => {
  it("admits the written-out recursion over `FabricValue` and `CellHandle`, and is wider by the plus-instance arm", () => {
    // The type checker decides the claim; at run time only the carrier is
    // observable.
    expect(typeof clientCellValueTypeChecks).toBe("function");
  });
});
