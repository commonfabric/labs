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
    each: (Writable<string> | string)[];
    out: Writable<unknown>;
}
// FIXTURE: cell-or-value-parameter
// Verifies: an identifier whose type has a plain-value arm beside a cell arm
//   is re-rooted only where it is a reactive node by provenance
//   pattern body: { p: maybe }           → { p: maybe.for(["q", "p"], true) }
//   pattern body: { p: alias }           → { p: alias.for(["viaAlias", "p"], true) },
//                                          `const alias = maybe` being the
//                                          same node under another name
//   reactive `.map()`: { p: item }       → { p: item.for(["__patternResult", "p"], true) }
//   parenthesized callback: { p: maybe } → { p: maybe.for(["q", "p"], true) }
//   handler body: { p: maybe }, { p: alias }
//                                        → unchanged
//   plain function, declared or bound to a `const`: { p: value }
//                                        → unchanged
// Context: a pattern input is a reactive node whatever its type says, and
//   carries `.for()`; the same state member in a handler, or a plain
//   function's parameter, is a value that may be the string, on which
//   `.for()` would throw.
function boxDeclared(value: Writable<string> | string) {
    const boxed = { p: value };
    return boxed;
}
__cfHardenFn(boxDeclared);
const boxBound = __cfHardenFn((value: Writable<string> | string) => {
    const boxed = { p: value };
    return boxed;
});
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
    const alias = maybe;
    const e = { p: maybe };
    const viaAlias = { p: alias };
    out.set([e, viaAlias, boxDeclared(maybe), boxBound(maybe)]);
});
export const parenthesized = pattern((__cf_pattern_input) => {
    const maybe = __cf_pattern_input.key("maybe");
    const q = { p: maybe.for(["q", "p"], true) };
    return { q };
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
        each: {
            type: "array",
            items: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "string",
                        asCell: ["cell"]
                    }]
            }
        },
        out: {
            type: "unknown",
            asCell: ["cell"]
        }
    },
    required: ["maybe", "each", "out"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
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
    required: ["q"]
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return ({ p: item.for(["__patternResult", "p"], true) });
}, {
    type: "object",
    properties: {
        element: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "string",
                    asCell: ["cell"]
                }]
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
export default pattern((__cf_pattern_input) => {
    const maybe = __cf_pattern_input.key("maybe");
    const each = __cf_pattern_input.key("each");
    const out = __cf_pattern_input.key("out");
    const alias = maybe;
    const q = { p: maybe.for(["q", "p"], true) };
    const viaAlias = { p: alias.for(["viaAlias", "p"], true) };
    const rows = each.mapWithPattern(__cfPattern_1, {}).for("rows", true);
    return { record: record({ maybe, each, out }).for({ stream: ["__patternResult", "record"] }, true), q, viaAlias, rows };
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
        each: {
            type: "array",
            items: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "string",
                        asCell: ["cell"]
                    }]
            }
        },
        out: {
            type: "unknown",
            asCell: ["cell"]
        }
    },
    required: ["maybe", "each", "out"]
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
        },
        viaAlias: {
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
        },
        rows: {
            type: "array",
            items: {
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
        }
    },
    required: ["record", "q", "viaAlias", "rows"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    record,
    __cfPattern_1
});
