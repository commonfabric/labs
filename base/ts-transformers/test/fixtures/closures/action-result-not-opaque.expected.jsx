function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * action() results used as event handlers in JSX. action() is an
 * opaque origin but handler results are typically used directly
 * (no property access), so opaque classification doesn't affect them.
 */
import { action, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    label: string;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
    count.set(count.get() + 1);
});
const __cfHandler_2 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
    count.set(count.get() - 1);
});
// FIXTURE: action-result-not-opaque
// Verifies: action() results used as JSX event handlers are not marked asOpaque in the output
//   action(() => count.set(...)) → handler(false, { count: { asCell } }, (_, { count }) => ...)({ count })
// Context: action() is an opaque origin, but handler results are used directly (no property access)
export default pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    const count = new Writable(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    const increment = __cfHandler_1({
        count: count
    }).for({ stream: "increment" }, true);
    const decrement = __cfHandler_2({
        count: count
    }).for({ stream: "decrement" }, true);
    return {
        [UI]: (<div>
        <span>{label}: {count}</span>
        <cf-button onClick={increment}>+</cf-button>
        <cf-button onClick={decrement}>-</cf-button>
      </div>),
        count: count.for(["__patternResult", "count"], true)
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
        },
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["$UI", "count"],
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
    __cfHandler_1,
    __cfHandler_2
});
