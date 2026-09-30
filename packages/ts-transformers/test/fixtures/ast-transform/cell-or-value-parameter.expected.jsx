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
    maybe: Writable<string> | string;
    out: Writable<unknown>;
}
// FIXTURE: cell-or-value-parameter
// Verifies: an identifier whose type has a plain-value arm beside a cell arm
//   is re-rooted only where it is a reactive node by provenance
//   pattern body: { p: maybe }  → { p: maybe.for(["q", "p"], true) }
//   handler body: { p: maybe }  → unchanged
// Context: a pattern input is a reactive node whatever its type says, and
//   carries `.for()`; the same state member in a handler is a value that may
//   be the string, on which `.for()` would throw.
const record = handler({
    asCell: ["opaque"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        maybe: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "string",
                    asCell: ["cell"]
                }]
        },
        out: {
            type: "unknown",
            asCell: ["writeonly"]
        }
    },
    required: ["maybe", "out"]
} as const satisfies __cfHelpers.JSONSchema, (_, { maybe, out }) => {
    const e = { p: maybe };
    out.set(e);
});
export default pattern((__cf_pattern_input) => {
    const maybe = __cf_pattern_input.key("maybe");
    const out = __cf_pattern_input.key("out");
    const q = { p: maybe.for(["q", "p"], true) };
    return { record: record({ maybe, out }).for({ stream: ["__patternResult", "record"] }, true), q };
}, {
    type: "object",
    properties: {
        maybe: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "string",
                    asCell: ["cell"]
                }]
        },
        out: {
            type: "unknown",
            asCell: ["cell"]
        }
    },
    required: ["maybe", "out"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        record: {
            asCell: ["stream", "opaque"]
        },
        q: {
            type: "object",
            properties: {
                p: {
                    anyOf: [{
                            type: "string"
                        }, {
                            type: "string",
                            asCell: ["cell"]
                        }]
                }
            },
            required: ["p"]
        }
    },
    required: ["record", "q"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    record
});
