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
    text: Writable<string>;
    count: Writable<number>;
    out: Writable<unknown>;
}
function cellOrString(cell: Writable<string>): Writable<string> | string {
    return cell;
}
__cfHardenFn(cellOrString);
function cellOrStringOrNone(cell: Writable<string> | undefined): Writable<string> | string | undefined {
    return cell;
}
__cfHardenFn(cellOrStringOrNone);
function eitherCell(text: Writable<string>, count: Writable<number>): Writable<string> | Writable<number> {
    return text.get() ? text : count;
}
__cfHardenFn(eitherCell);
// FIXTURE: handler-cell-or-value-call
// Verifies: a cause goes on a value only when its type is a cell in every arm
//   a value can take
//   const a = cellOrString(state.text)        → unchanged (a string arm)
//   const b = cellOrStringOrNone(...)         → unchanged (a string arm)
//   const c = eitherCell(...)                 → eitherCell(...).for("c", true)
//   const d = state.profile?.resolveAsCell()! → state.profile?.resolveAsCell()!.for("d", true)
//   { text: a }                               → unchanged (a string arm)
//   { count: c }                              → { count: c.for(["e", "count"], true) }
// Context: `.for()` is not a method of a string, so a plain `.for()` on a
//   value that may be one throws, and a `?.for()` would throw the same way. A
//   non-null assertion says the value is present, so the access stays plain
//   even on an optional chain.
const record = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        text: {
            type: "string",
            asCell: ["readonly"]
        },
        profile: {
            type: ["string", "undefined"],
            asCell: ["readonly"]
        },
        count: {
            type: "number",
            asCell: ["readonly"]
        },
        out: {
            type: "unknown",
            asCell: ["writeonly"]
        }
    },
    required: ["text", "count", "out"]
} as const satisfies __cfHelpers.JSONSchema, (_, state) => {
    const a = cellOrString(state.text);
    const b = cellOrStringOrNone(state.profile);
    const c = eitherCell(state.text, state.count).for("c", true);
    const d = state.profile?.resolveAsCell()!.for("d", true);
    const e = { text: a, count: c.for(["e", "count"], true) };
    state.out.set([a, b, c, d, e]);
});
export default pattern((__cf_pattern_input) => {
    const profile = __cf_pattern_input.key("profile");
    const text = __cf_pattern_input.key("text");
    const count = __cf_pattern_input.key("count");
    const out = __cf_pattern_input.key("out");
    return { record: record({ profile, text, count, out }).for({ stream: ["__patternResult", "record"] }, true) };
}, {
    type: "object",
    properties: {
        profile: {
            type: "string",
            asCell: ["cell"]
        },
        text: {
            type: "string",
            asCell: ["cell"]
        },
        count: {
            type: "number",
            asCell: ["cell"]
        },
        out: {
            type: "unknown",
            asCell: ["cell"]
        }
    },
    required: ["text", "count", "out"]
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
