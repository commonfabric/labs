function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, NAME, pattern, toSchema } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    selectedIndex: number | Default<number, -1>;
    threshold: number | Default<number, -0.5>;
}
const inputSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        selectedIndex: {
            type: "number",
            "default": -1
        },
        threshold: {
            type: "number",
            "default": -0.5
        }
    },
    required: ["selectedIndex", "threshold"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: negative-number-default
// Verifies: negative numeric defaults are emitted as unary minus expressions
// (the TS factory rejects negative numbers in createNumericLiteral)
export default pattern((__cf_pattern_input) => {
    const selectedIndex = __cf_pattern_input.key("selectedIndex");
    const threshold = __cf_pattern_input.key("threshold");
    return ({
        [NAME]: "Negative defaults",
        selectedIndex,
        threshold,
    });
}, inputSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        selectedIndex: {
            type: "number"
        },
        threshold: {
            type: "number"
        }
    },
    required: ["$NAME", "selectedIndex", "threshold"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
