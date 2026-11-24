/**
 * NULL ELIMINATION REPRODUCTION - Using Actual Common Fabric Types
 *
 * This uses the real Reactive from commonfabric to verify the bug.
 *
 * RUN: deno run -A test/fixtures/bug-repro/verify-actual.ts
 */

import type { Reactive, OpaqueCell } from "commonfabric";

//
// TEST CASES
//

// Direct nullable type
type Direct = Reactive<string | null>;
type DirectInner = Direct extends OpaqueCell<infer T> ? T : never;
type DirectGet = Direct extends { get(): infer R } ? R : never;

// Via object property
interface State {
  value: string | null;
  defaultValue: string;
}

type StateRef = Reactive<State>;
type ValueProp = StateRef["value"];
type ValueInner = ValueProp extends OpaqueCell<infer T> ? T : never;
type ValueGet = ValueProp extends { get(): infer R } ? R : never;

// With Required<>
type RequiredStateRef = Reactive<Required<State>>;
type RequiredValueProp = RequiredStateRef["value"];
type RequiredValueInner = RequiredValueProp extends OpaqueCell<infer T> ? T : never;

//
// EXPORTS
//
export type {
  Direct, DirectInner, DirectGet,
  StateRef, ValueProp, ValueInner, ValueGet,
  RequiredStateRef, RequiredValueProp, RequiredValueInner,
};
