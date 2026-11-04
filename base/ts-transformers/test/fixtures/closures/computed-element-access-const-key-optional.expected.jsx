function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const KEY = "k";
const __cfLift_1 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers[KEY]?.space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    n: __cfHelpers.ReadonlyCell<number>;
    catalog: __cfHelpers.ReadonlyCell<Record<string, any>>;
}, boolean>(({ n, catalog }) => n.get() === 1 && catalog.get().offers?.[KEY]?.space === "room", {
    type: "object",
    properties: {
        n: {
            type: "number",
            asCell: ["readonly"]
        },
        catalog: {
            type: "object",
            properties: {},
            additionalProperties: true,
            asCell: ["readonly"]
        }
    },
    required: ["n", "catalog"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-element-access-const-key-optional
// Verifies: an optional chain through an element access with a literal-typed key keeps the capture it reads
//   catalog.get().offers[KEY]?.space and catalog.get().offers?.[KEY]?.space both keep catalog in the lift's input
// Context: Two captures, so a capture whose read went unrecorded would be shrunk out of the lift's input
export default pattern(() => {
    const catalog = new Writable<Record<string, any>>({ offers: {} }, {
        type: "object",
        properties: {},
        additionalProperties: true
    } as const satisfies __cfHelpers.JSONSchema).for("catalog", true);
    const n = new Writable<number>(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("n", true);
    const optionalMember = __cfLift_1({
        n: n,
        catalog: catalog
    }).for("optionalMember", true);
    const optionalElement = __cfLift_2({
        n: n,
        catalog: catalog
    }).for("optionalElement", true);
    return { optionalMember, optionalElement };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        optionalMember: {
            type: "boolean"
        },
        optionalElement: {
            type: "boolean"
        }
    },
    required: ["optionalMember", "optionalElement"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
