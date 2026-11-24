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
    selectedValue: Cell<string>;
    changeCount: Cell<number>;
}
const __cfHandler_1 = __cfHelpers.handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                value: true
            },
            required: ["value"]
        }
    },
    required: ["detail"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                changeCount: {
                    type: "number",
                    asCell: ["cell"]
                },
                selectedValue: {
                    type: "string",
                    asCell: ["writeonly"]
                }
            },
            required: ["changeCount", "selectedValue"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, (event, { state }) => {
    state.selectedValue.set(event.detail.value);
    state.changeCount.set(state.changeCount.get() + 1);
});
// FIXTURE: handler-event-param
// Verifies: inline handler with a named event parameter generates event + capture schemas
//   onct-change={(event) => ...} → handler(event schema with detail.value, capture schema, (event, { state }) => ...)({ state })
// Context: Typed cf-select event; event param is not destructured, used as event.detail.value
export default pattern((state) => {
    return {
        [UI]: (<cf-select $value={state.key("selectedValue")} items={[
                { label: "Option A", value: "a" },
                { label: "Option B", value: "b" },
            ]} oncf-change={__cfHandler_1({
            state: {
                selectedValue: state.key("selectedValue"),
                changeCount: state.key("changeCount")
            }
        })}/>),
    };
}, {
    type: "object",
    properties: {
        selectedValue: {
            type: "string",
            asCell: ["cell"]
        },
        changeCount: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["selectedValue", "changeCount"]
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
