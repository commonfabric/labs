function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, computed, lift, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const liftSummary = lift(({ primary, secondary }) => {
    const primaryValue = primary.get();
    const secondaryValue = secondary.get();
    return {
        primary: primaryValue,
        secondary: secondaryValue,
        difference: primaryValue - secondaryValue,
    };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["readonly"]
        },
        secondary: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        primary: {
            type: "number"
        },
        secondary: {
            type: "number"
        },
        difference: {
            type: "number"
        }
    },
    required: ["primary", "secondary", "difference"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    summary: {
        difference: any;
    };
}, any>(({ summary }) => summary.difference, {
    type: "object",
    properties: {
        summary: {
            type: "object",
            properties: {
                difference: true
            },
            required: ["difference"]
        }
    },
    required: ["summary"]
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: context-lift-result-property-projection-shorthand
// Verifies: shorthand object returns preserve the projected computed() result type
//   return { difference } → result schema difference: number
export default pattern((__cf_pattern_input) => {
    const primary = __cf_pattern_input.key("primary");
    const secondary = __cf_pattern_input.key("secondary");
    const summary = liftSummary({ primary: primary.for(["summary", "primary"], true), secondary: secondary.for(["summary", "secondary"], true) }).for("summary", true);
    const difference = __cfLift_1({ summary: {
            difference: summary.key("difference")
        } }).for("difference", true);
    return { difference };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["cell"]
        },
        secondary: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        difference: true
    },
    required: ["difference"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    liftSummary,
    __cfLift_1
});
