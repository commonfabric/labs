function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "cf-button": any;
        }
    }
}
interface State {
    count: number;
}
const existing = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/State"
        }
    },
    required: ["state"],
    $defs: {
        State: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_event, { state }: {
    state: State;
}) => {
    console.log(state.count);
});
// FIXTURE: handler-existing-reference
// Verifies: pre-declared handler() call site is NOT re-wrapped; only its schema is generated
//   existing({ state }) → existing({ state }) (call site unchanged)
//   handler(fn) at declaration → handler(false, captureSchema, fn) (schema injected at definition)
// Context: handler() declared outside the pattern; the transform adds schemas but does not re-extract
export default pattern((state) => {
    return {
        [UI]: (<cf-button onClick={existing({ state })}>
        Existing
      </cf-button>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
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
    existing
});
