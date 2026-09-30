function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { handler, pattern, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    profile?: Writable<string>;
    out: Writable<unknown>;
}
function maybeCell(cell: Writable<string> | undefined): Writable<string> | undefined {
    return cell;
}
__cfHardenFn(maybeCell);
// FIXTURE: handler-nullable-cell-const
// Verifies: a cause for a value that may be nullish goes on an optional `.for()`
//   const a = state.profile?.resolveAsCell() → state.profile?.resolveAsCell()?.for("a", true)
//   const b = maybeCell(state.profile)       → maybeCell(state.profile)?.for("b", true)
//   const c = state.out.resolveAsCell()      → state.out.resolveAsCell().for("c", true)
//   { profile: a }                           → { profile: a?.for(["d", "profile"], true) }
//   maybeCell(state.profile) as unknown      → (maybeCell(state.profile) as unknown)?.for("e", true)
//   maybeCell(state.profile) satisfies …     → (maybeCell(state.profile) satisfies …)?.for("f", true)
//   maybeCell(state.profile)!                → maybeCell(state.profile)!.for("g", true)
// Context: An absent optional cell leaves the value `undefined`, and a plain
//   `.for()` on it throws.
const record = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        profile: {
            type: ["string", "undefined"],
            asCell: ["readonly"]
        },
        out: {
            type: "unknown",
            asCell: ["readonly"]
        }
    },
    required: ["out"]
} as const satisfies __cfHelpers.JSONSchema, (_, state) => {
    const a = state.profile?.resolveAsCell()?.for("a", true);
    const b = maybeCell(state.profile)?.for("b", true);
    const c = state.out.resolveAsCell().for("c", true);
    const d = { profile: a?.for(["d", "profile"], true) };
    const e = (maybeCell(state.profile) as unknown)?.for("e", true);
    const f = (maybeCell(state.profile) satisfies Writable<string> | undefined)?.for("f", true);
    const g = maybeCell(state.profile)!.for("g", true);
    c.set([a, b, d, e, f, g]);
});
export default pattern((__cf_pattern_input) => {
    const profile = __cf_pattern_input.key("profile");
    const out = __cf_pattern_input.key("out");
    return { record: record({ profile, out }).for({ stream: ["__patternResult", "record"] }, true) };
}, {
    type: "object",
    properties: {
        profile: {
            type: "string",
            asCell: ["cell"]
        },
        out: {
            type: "unknown",
            asCell: ["cell"]
        }
    },
    required: ["out"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        record: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["record"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    record
});
