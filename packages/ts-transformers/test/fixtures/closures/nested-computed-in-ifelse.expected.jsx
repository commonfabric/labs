function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * Regression test: computed() inside ifElse branch should not double-wrap .get()
 *
 * When a computed() callback is inside an ifElse branch, the ReactiveJSX
 * transformer's rewriteChildExpressions should NOT wrap expressions like
 * `toggle.get()` in an extra lift-applied computation, since the computed callback is already
 * a safe reactive context.
 *
 * Bug: secondToggle.get() was returning CellImpl instead of boolean
 * Fix: Added isInsideSafeCallbackWrapper check in rewriteChildExpressions
 */
import { computed, ifElse, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_h2cec5ba7cbc2 = __cfHelpers.lift<{
    secondToggle: __cfHelpers.ReadonlyCell<boolean>;
}, { background: string; }>(({ secondToggle }) => {
    const val = secondToggle.get();
    return { background: val ? "green" : "red" };
}, {
    type: "object",
    properties: {
        secondToggle: {
            type: "boolean",
            asCell: ["readonly"]
        }
    },
    required: ["secondToggle"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        background: {
            type: "string"
        }
    },
    required: ["background"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h2cec5ba7cbc2_2 = __cfHelpers.lift<{
    secondToggle: __cfHelpers.ReadonlyCell<boolean>;
}, { background: string; }>(({ secondToggle }) => {
    // This .get() should NOT be wrapped in an extra lift-applied computation
    const val = secondToggle.get();
    return { background: val ? "green" : "red" };
}, {
    type: "object",
    properties: {
        secondToggle: {
            type: "boolean",
            asCell: ["readonly"]
        }
    },
    required: ["secondToggle"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        background: {
            type: "string"
        }
    },
    required: ["background"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: nested-computed-in-ifelse
// Verifies: computed() inside ifElse branches transforms to the lift-applied form without double-wrapping .get()
//   computed(() => { secondToggle.get(); ... }) → lift(({ secondToggle }) => { secondToggle.get(); ... })({ secondToggle })
//   ternary (showOuter ? ... : ...) → ifElse(showOuter, ..., ...)
// Context: Regression test — .get() inside a computed() that is nested within
//   an ifElse branch must NOT get an extra lift-applied wrapper, since computed is
//   already a safe reactive context.
export default pattern(() => {
    const showOuter = new Writable(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showOuter", true);
    const secondToggle = new Writable(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("secondToggle", true);
    return {
        [UI]: (<div>
        {/* Case A: Top-level computed - always worked */}
        <div style={__cfLift_h2cec5ba7cbc2({ secondToggle: secondToggle })}>Case A</div>

        {/* Case B: Computed inside ifElse - this was the bug */}
        {ifElse({
                type: "boolean",
                asCell: ["cell"]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{}, {
                        type: "object",
                        properties: {}
                    }]
            } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, showOuter, <div style={__cfLift_h2cec5ba7cbc2_2({ secondToggle: secondToggle })}>Case B</div>, <div>Hidden</div>)}
      </div>),
    };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
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
    __cfLift_h2cec5ba7cbc2,
    __cfLift_h2cec5ba7cbc2_2,
    __cfLift_1: __cfLift_h2cec5ba7cbc2,
    __cfLift_2: __cfLift_h2cec5ba7cbc2_2
});
