function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    label: string;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        __cf_handler_event: {
            type: "string"
        }
    },
    required: ["__cf_handler_event"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event_1, { __cf_handler_event }) => __cf_handler_event);
// FIXTURE: handler-reserved-capture
// Verifies: captured variable named __cf_handler_event is renamed to avoid collision with the synthetic event param
//   onClick={() => __cf_handler_event) → handler(false, { __cf_handler_event: ... }, (__cf_handler_event_1, { __cf_handler_event }) => ...)
// Context: Edge case -- user variable collides with internal __cf_handler_event name; event param gets suffixed
export default pattern((state) => {
    const __cf_handler_event = state.key("label");
    return {
        [UI]: (<button type="button" onClick={__cfHandler_1({
            __cf_handler_event: __cf_handler_event
        })}>
        Echo
      </button>),
    };
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
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
