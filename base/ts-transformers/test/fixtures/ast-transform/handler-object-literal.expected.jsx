function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, handler, pattern } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    value: Cell<number>;
    name?: Cell<string>;
}
const myHandler = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (_, state: State) => {
    state.value.set(state.value.get() + 1);
});
// FIXTURE: handler-object-literal
// Verifies: handler gets schema from inline param type; handler invocations use state.key()
//   handler((_, state: State) => ...)          → handler(false, stateSchema, fn)
//   myHandler({ value: state.value, ... })     → myHandler({ value: state.key("value"), ... })
//   myHandler(state)                           → myHandler(state) (unchanged)
// Context: Pattern already has explicit schemas; only handler schema injection and property access transforms apply
export default pattern((state) => {
    return {
        // Test case 1: Object literal with all properties from state
        onClick1: myHandler({ value: state.key("value"), name: state.key("name") }).for({ stream: ["__patternResult", "onClick1"] }, true),
        // Test case 2: Object literal with all properties (explicitly listed)
        onClick2: myHandler({ value: state.key("value"), name: state.key("name") }).for({ stream: ["__patternResult", "onClick2"] }, true),
        // Test case 3: Direct state passing (what we want to transform to)
        onClick3: myHandler(state).for({ stream: ["__patternResult", "onClick3"] }, true)
    };
}, {
    type: "object",
    properties: {
        value: { type: "number", asCell: ["cell"] },
        name: { type: "string", asCell: ["cell"] },
    },
    required: ["value"],
}, {
    type: "object",
    properties: {
        onClick1: {
            type: "unknown",
            asCell: ["stream"]
        },
        onClick2: {
            type: "unknown",
            asCell: ["stream"]
        },
        onClick3: {
            type: "unknown",
            asCell: ["stream"]
        }
    },
    required: ["onClick1", "onClick2", "onClick3"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    myHandler
});
