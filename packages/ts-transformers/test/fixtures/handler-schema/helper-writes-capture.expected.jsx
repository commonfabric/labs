function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, handler, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Count = Writable<number | Default<0>>;
function bump(count: Count): void {
    count.set(count.get() + 1);
}
__cfHardenFn(bump);
// Declared without a body, so the analysis has no summary of what it reads.
declare function audit(value: unknown): void;
function bumpAudited(count: Count): void {
    const current = count.get();
    audit(current);
    count.set(current + 1);
}
__cfHardenFn(bumpAudited);
function currentOf(count: Count): number {
    return count.get();
}
__cfHardenFn(currentOf);
const viaHelper = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0,
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
    bump(count);
});
const viaAuditedHelper = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0,
            asCell: ["cell"]
        },
        label: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"],
            asCell: ["readonly"]
        }
    },
    required: ["count", "label"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count, label }) => {
    bumpAudited(count);
    return label.get().text;
});
const viaReadingHelper = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0,
            asCell: ["readonly"]
        },
        out: {
            type: "number",
            asCell: ["writeonly"]
        }
    },
    required: ["count", "out"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count, out }) => {
    out.set(currentOf(count));
});
// FIXTURE: helper-writes-capture
// Verifies: a handler's state capture handed to a helper the same file
// declares is charged what the helper does with it
//   bump(count)        → count: asCell ["cell"] (read and written there)
//   bumpAudited(count) → count: asCell ["cell"], though the helper also hands
//                        the value to a function with no body to analyze;
//                        label beside it still narrows to the `text` it reads
//   currentOf(count)   → count: asCell ["readonly"] (only read there)
export { viaAuditedHelper, viaHelper, viaReadingHelper };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
