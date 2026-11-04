function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { generateTextStream, isPending, pattern, resultOf, UI, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    text: __cfHelpers.AsyncStreamResult<string, string>;
}, boolean>(({ text }) => isPending(text), {
    type: "object",
    properties: {
        text: {
            type: "unknown"
        }
    },
    required: ["text"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { unavailableInputPolicy: [{ path: ["text"], reasons: ["pending"] }] });
// FIXTURE: generate-text-local-ternary
// Verifies: local reactive builder results still trigger JSX ternary lowering
//   isPending(text) ? "Loading" : resultOf(text) -> __cfHelpers.ifElse(...)
// Context: `text` is a local `generateTextStream()` result rather than a pattern
// input binding, so this exercises expression-site lowering on local reactive
// aliases in JSX.
export default pattern(() => {
    const text = generateTextStream({ prompt: "hi" }).for("text", true);
    return {
        [UI]: <div>{__cfHelpers.ifElse(true as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ text: text }), "Loading", resultOf(text))}</div>,
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
