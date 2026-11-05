function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { NAME, Reactive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const count: Reactive<number> = {} as any;
const _element = <div>{count}</div>;
// FIXTURE: no-transform-simple-ref
// Verifies: a bare Reactive in JSX ({count}) is NOT wrapped in a lift-applied computation -- passed through as-is
//   <div>{count}</div> → <div>{count}</div>  (unchanged)
// Context: Negative test -- simple ref interpolation needs no transformation
export default pattern((_state) => {
    return {
        [NAME]: "test",
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        }
    },
    required: ["$NAME"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
