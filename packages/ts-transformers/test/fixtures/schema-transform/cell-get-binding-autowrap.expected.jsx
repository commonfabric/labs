function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_h0939521a2ccd = __cfHelpers.lift<{
    layout: __cfHelpers.Writable<string>;
}, number>(({ layout }) => layout.get().trim().length, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: cell-get-binding-autowrap
// Verifies: a `cell.get()` that feeds a chained computation at a
//   variable-initializer binding is auto-wrapped into a lift, the same way it is
//   in a JSX expression. A read with no lowerable container site at all — a bare
//   `cell.get();` statement — is still rejected with `pattern-context:get-call`.
// Context: lets an author drop a `computed()` wrapper and write the plain
//   expression even when the input is a Writable/Cell. The terminal-read
//   spellings of the same binding are covered by
//   `cell-get-terminal-binding-autowrap`.
export default pattern((__cf_pattern_input) => {
    const layout = __cf_pattern_input.key("layout");
    const len = __cfLift_h0939521a2ccd({ layout: layout }).for("len", true);
    return { len };
}, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        len: {
            type: "number"
        }
    },
    required: ["len"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_h0939521a2ccd,
    __cfLift_1: __cfLift_h0939521a2ccd
});
