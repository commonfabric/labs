function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const ANY_KEY: string = "k";
// FIXTURE: handler-element-access-dynamic-key
// Verifies: a handler state member read through an element access by a key that can name any member stays in the state schema
//   catalog.get().offers[ANY_KEY].space reads catalog in full, beside the write to n
// Context: Two state members, so a dropped read would shrink catalog out of the state schema
const touch = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        },
        n: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["catalog", "n"]
} as const satisfies __cfHelpers.JSONSchema, (_, { catalog, n }) => {
    if (catalog.get().offers[ANY_KEY].space === "room")
        n.set(n.get() + 1);
});
export default pattern(() => {
    const catalog = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    return { touch: touch({ catalog, n }).for({ stream: ["__patternResult", "touch"] }, true) };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        touch: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["touch"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    touch
});
