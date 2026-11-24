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
const __cfHandler_1 = __cfHelpers.handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                counter: {
                    type: "number",
                    asCell: ["cell"]
                }
            },
            required: ["counter"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, (_, { state }) => state.counter.set(state.counter.get() + 1));
// FIXTURE: handler-unused-event
// Verifies: inline handler with an unused event param (_) still generates an event schema placeholder
//   onClick={(_: unknown) => state.counter.set(...)) → handler(event schema, capture schema, (_, { state }) => ...)({ state })
// Context: Event param is named _ (unused); transformer emits a generic event schema placeholder
export default pattern((state) => {
    return {
        [UI]: (<button type="button" onClick={__cfHandler_1({
            state: {
                counter: state.key("counter")
            }
        })}>
        Increment (ignore event)
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
