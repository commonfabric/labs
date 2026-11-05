function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { NAME, pattern, str } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PatternState {
    value: number;
}
function format(n: number): string {
    return `#${n}`;
}
__cfHardenFn(format);
const __cfLift_1 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, string>(({ cell }) => format(cell.value), {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, number>(({ cell }) => cell.value + 1, {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: str-template-call-interpolation
// Verifies: reactive lowering of expressions interpolated into a str`` tagged template.
//   The str runtime lifts its interpolation over the values it receives, so any value
//   that is a bare reactive READ stays reactive (str re-reads the cell). But a value
//   produced by a COMPUTED expression (a call, a binary op) must be lifted per-span,
//   or it freezes at construction. This mirrors how JSX `{expr}` is handled.
//     ${cell.value}          → ${cell.key("value")}              (bare read, not lifted)
//     ${format(cell.value)}  → ${__cfHelpers.lift(...)(...)}      (call lifted)
//     ${cell.value + 1}      → ${__cfHelpers.lift(...)(...)}      (binary lifted)
// Context: Regression for CT-1621 — derive(cell.value, String) migrated to bare
//   String(cell.value) inside str`` silently dropped reactivity because interpolation
//   call-expressions were never classified as lowerable expression sites.
export default pattern((cell) => {
    return {
        [NAME]: str `bare ${cell.key("value")} call ${__cfLift_1({ cell: {
                value: cell.key("value")
            } })} math ${__cfLift_2({ cell: {
                value: cell.key("value")
            } })}`,
        value: cell.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        value: {
            type: "number"
        }
    },
    required: ["$NAME", "value"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
