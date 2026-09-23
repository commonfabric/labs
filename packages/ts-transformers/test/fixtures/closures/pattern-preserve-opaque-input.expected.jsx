function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, type Writable, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    foo: string;
    bar: string;
}
const __cfLift_1 = __cfHelpers.lift<{
    input: __cfHelpers.Writable<State>;
}, string>(({ input }) => input.key("foo").get(), {
    type: "object",
    properties: {
        input: {
            type: "object",
            properties: {
                foo: {
                    type: "string"
                }
            },
            required: ["foo"],
            asCell: ["readonly"]
        }
    },
    required: ["input"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-preserve-opaque-input
// Verifies: Writable<T> pattern input is preserved as an opaque ref, with JSX .get() wrapped in a lift-applied computation
//   input.key("foo").get() in JSX → lift(({ input }) => input.key("foo").get())({ input })
// Context: When the pattern parameter is typed as Writable<State>, the input
//   schema uses asOpaque: true. The .get() call inside JSX is not in a safe
//   reactive context, so it gets wrapped in a lift-applied computation.
export default pattern((input: Writable<State>) => {
    return {
        [UI]: <div>{__cfLift_1({ input: input })}</div>,
    };
}, {
    $ref: "#/$defs/State",
    asCell: ["opaque"],
    $defs: {
        State: {
            type: "object",
            properties: {
                foo: {
                    type: "string"
                },
                bar: {
                    type: "string"
                }
            },
            required: ["foo", "bar"]
        }
    }
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
    __cfLift_1
});
