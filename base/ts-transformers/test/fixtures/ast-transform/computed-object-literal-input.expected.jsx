function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, computed, lift } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const stage = __cfHelpers.__cf_data(cell<string>("initial", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("stage", true));
const attemptCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("attemptCount", true));
const acceptedCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("acceptedCount", true));
const rejectedCount = __cfHelpers.__cf_data(cell<number>(0, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema).for("rejectedCount", true));
const __cfLift_1 = lift((value: string) => value, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: computed-object-literal-input
// Verifies: cell(), lift(), and computed() all get schemas injected from type annotations
//   cell<string>("initial")             → cell<string>("initial", { type: "string" })
//   lift((value: string) => value)      → lift(inputSchema, outputSchema, fn)
//   computed(() => `...`)               → captures lift outputs into lift(inputSchema, outputSchema, { ... }, fn)
// Context: No export default; first export-relevant statement is the cells/lifts/computed at top level
const normalizedStage = __cfHelpers.__cf_data(__cfLift_1(stage).for("normalizedStage", true));
const __cfLift_2 = lift((count: number) => count, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const attempts = __cfHelpers.__cf_data(__cfLift_2(attemptCount).for("attempts", true));
const __cfLift_3 = lift((count: number) => count, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const accepted = __cfHelpers.__cf_data(__cfLift_3(acceptedCount).for("accepted", true));
const __cfLift_4 = lift((count: number) => count, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const rejected = __cfHelpers.__cf_data(__cfLift_4(rejectedCount).for("rejected", true));
const __cfLift_5 = __cfHelpers.lift(() => `stage:${normalizedStage} attempts:${attempts}` +
    ` accepted:${accepted} rejected:${rejected}`, false, undefined, { completeSchedulerScopeSummary: true });
const _summary = __cfHelpers.__cf_data(__cfLift_5().for("_summary", true));
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5
});
