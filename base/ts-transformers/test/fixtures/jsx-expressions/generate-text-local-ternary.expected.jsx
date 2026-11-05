function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { generateText, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: generate-text-local-ternary
// Verifies: local reactive builder results still trigger JSX ternary lowering
//   text.pending ? "Loading" : text.result -> __cfHelpers.ifElse(...)
// Context: `text` is a local `generateText()` result rather than a pattern
// input binding, so this exercises expression-site lowering on local reactive
// aliases in JSX.
export default pattern(() => {
    const text = generateText({ prompt: "hi" }).for("text", true);
    return {
        [UI]: <div>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, text.key("pending"), "Loading", text.key("result"))}</div>,
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
