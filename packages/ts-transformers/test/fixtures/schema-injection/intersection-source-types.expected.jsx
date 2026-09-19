function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { type OpaqueCell, toSchema } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: intersection-source-types
// Verifies: intersections retain source type distinctions through schema
// generation. Opaque cells and `void` have different intersection behavior;
// nested and named branded primitives retain their primitive constraints.
// Expected: each call becomes the checker's `true` or `false` schema.
type Brand = string & {
    topic: unknown;
};
type Folded = (string & {
    a: 1;
}) | (number & {
    b: 2;
});
type OpaqueCompatible = any & OpaqueCell<any> & string & unknown;
export const validOpaque: OpaqueCompatible = 123;
export const opaqueCompatible = true as const satisfies __cfHelpers.JSONSchema;
export const opaqueImpossible = false as const satisfies __cfHelpers.JSONSchema;
export const voidCompatible = true as const satisfies __cfHelpers.JSONSchema;
export const voidImpossible = false as const satisfies __cfHelpers.JSONSchema;
export const distinctSources = false as const satisfies __cfHelpers.JSONSchema;
export const unionSources = true as const satisfies __cfHelpers.JSONSchema;
export const nestedImpossible = false as const satisfies __cfHelpers.JSONSchema;
export const namedImpossible = false as const satisfies __cfHelpers.JSONSchema;
export const nestedWithoutAny = false as const satisfies __cfHelpers.JSONSchema;
export const nestedCompatible = true as const satisfies __cfHelpers.JSONSchema;
export const reducedInnerAny = true as const satisfies __cfHelpers.JSONSchema;
export const distributedBrand = false as const satisfies __cfHelpers.JSONSchema;
export const unionBesideAny = true as const satisfies __cfHelpers.JSONSchema;
export const foldedUnionBesideAny = true as const satisfies __cfHelpers.JSONSchema;
export const foldedUnion = __cfHelpers.__cf_data({
    type: "object",
    additionalProperties: true,
    $comment: "Unsupported intersection pattern: non-object constituent"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
