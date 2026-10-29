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
interface Point {
    x: number;
    y: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    point: __cfHelpers.ReadonlyCell<Point>;
    multiplier: __cfHelpers.ReadonlyCell<number>;
}, number>(({ point, multiplier }) => {
    const { x, y } = point.get();
    return (x + y) * multiplier.get();
}, {
    type: "object",
    properties: {
        point: {
            $ref: "#/$defs/Point",
            asCell: ["readonly"]
        },
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["point", "multiplier"],
    $defs: {
        Point: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: computed-destructured-param
// Verifies: a captured cell works alongside destructuring inside the computed body
//   computed(() => { const { x, y } = point.get(); ... }) → lift(...)({ point, multiplier })
// Context: `const { x, y } = point.get()` destructures inside the body, not a parameter
export default pattern(() => {
    const point = new Writable({ x: 10, y: 20 } as Point, {
        type: "object",
        properties: {
            x: {
                type: "number"
            },
            y: {
                type: "number"
            }
        },
        required: ["x", "y"]
    } as const satisfies __cfHelpers.JSONSchema).for("point", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Destructuring requires .get() first since the captured cell is not unwrapped
    const result = __cfLift_1({
        point: point,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
