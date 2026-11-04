function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    counter: Cell<number>;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {}
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, __cf_handler_params) => console.log("hi"));
// FIXTURE: handler-no-captures
// Verifies: inline handler with no captured outer variables still gets wrapped with empty captures
//   onClick={() => console.log("hi")) → handler(false, { properties: {} }, (_, __cf_handler_params) => ...)({})
// Context: No closed-over state; capture object is empty
export default pattern((_state) => {
    return {
        [UI]: (<button type="button" onClick={__cfHandler_1({})}>
        Log
      </button>),
    };
}, {
    type: "object",
    properties: {
        counter: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["counter"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
