function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { equals, handler, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Panel {
    name: string;
}
const compareFallback = handler({
    type: "object",
    properties: {
        panel: {
            $ref: "#/$defs/Panel",
            asCell: ["comparable"]
        }
    },
    required: ["panel"],
    $defs: {
        Panel: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        panels: {
            type: "array",
            items: {
                type: "unknown",
                asCell: ["comparable"]
            },
            asCell: ["readonly"]
        }
    },
    required: ["panels"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    const list = state.panels.get();
    if (list.some((item) => item.equals(event.panel)))
        return;
    if (equals(state ?? undefined, state))
        return;
});
// FIXTURE: identity-call-fallback-argument
// Verifies: a fallback handed to a known identity call is compared, not read,
// so the elements the body only compares stay comparable cells.
export { compareFallback };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
