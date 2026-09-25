function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, NAME, pattern, type Stream, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: contract-authored-shapes
// Verifies: contract mode serves every schema-generatable authored event
// shape verbatim — a discriminated union keeps both variants, an array event
// keeps its element type, a primitive event keeps its type, and an
// intersection's unread reference member goes opaque (verb-input-contract.md).
type UnionEv = {
    kind: "a";
    a: number;
} | {
    kind: "b";
    b: string;
};
type SectionEv = {
    base: string;
} & {
    extra: Writable<{
        z: number;
    }>;
};
interface Out {
    [NAME]: string;
    log: string[];
    addUnion: Stream<UnionEv, {
        ok: boolean;
    }>;
    addArr: Stream<string[], {
        n: number;
    }>;
    addStr: Stream<string, {
        n: number;
    }>;
    addSection: Stream<SectionEv, {
        ok: boolean;
    }>;
}
const __cfHandler_hfaa598c7156f = __cfHelpers.handler({
    anyOf: [{
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    "enum": ["a"]
                },
                a: {
                    type: "number"
                }
            },
            required: ["kind", "a"]
        }, {
            type: "object",
            properties: {
                kind: {
                    type: "string",
                    "enum": ["b"]
                },
                b: {
                    type: "string"
                }
            },
            required: ["kind", "b"]
        }]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        log: {
            anyOf: [{
                    type: "array",
                    items: {
                        type: "string"
                    }
                }, {
                    type: "undefined"
                }],
            asCell: ["writeonly"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, { log }) => {
    log?.push(event.kind);
    return { ok: true };
}, { resultSchema: {
        type: "object",
        properties: {
            ok: {
                type: "boolean"
            }
        },
        required: ["ok"]
    } as const satisfies __cfHelpers.JSONSchema });
const __cfHandler_h945fffca7161 = __cfHelpers.handler({
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {}
} as const satisfies __cfHelpers.JSONSchema, (event, __cf_action_params) => ({
    n: event.length,
}), { resultSchema: {
        type: "object",
        properties: {
            n: {
                type: "number"
            }
        },
        required: ["n"]
    } as const satisfies __cfHelpers.JSONSchema });
const __cfHandler_hc7858bec2146 = __cfHelpers.handler({
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {}
} as const satisfies __cfHelpers.JSONSchema, (event, __cf_action_params) => ({
    n: event.length,
}), { resultSchema: {
        type: "object",
        properties: {
            n: {
                type: "number"
            }
        },
        required: ["n"]
    } as const satisfies __cfHelpers.JSONSchema });
const __cfHandler_h8b5b8b11d10a = __cfHelpers.handler({
    type: "object",
    properties: {
        base: {
            type: "string"
        },
        extra: {
            type: "object",
            properties: {
                z: {
                    type: "number"
                }
            },
            required: ["z"],
            asCell: ["opaque"]
        }
    },
    required: ["base", "extra"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        log: {
            anyOf: [{
                    type: "array",
                    items: {
                        type: "string"
                    }
                }, {
                    type: "undefined"
                }],
            asCell: ["writeonly"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (event, { log }) => {
    log?.push(event.base);
    return { ok: true };
}, { resultSchema: {
        type: "object",
        properties: {
            ok: {
                type: "boolean"
            }
        },
        required: ["ok"]
    } as const satisfies __cfHelpers.JSONSchema });
export default pattern((__cf_pattern_input) => {
    const log = __cf_pattern_input.key("log");
    const addUnion = __cfHandler_hfaa598c7156f({
        log: log
    }).for({ stream: "addUnion" }, true);
    const addArr = __cfHandler_h945fffca7161({}).for({ stream: "addArr" }, true);
    const addStr = __cfHandler_hc7858bec2146({}).for({ stream: "addStr" }, true);
    const addSection = __cfHandler_h8b5b8b11d10a({
        log: log
    }).for({ stream: "addSection" }, true);
    return { [NAME]: "p", log: log!.for(["__patternResult", "log"], true), addUnion: addUnion.for({ stream: ["__patternResult", "addUnion"] }, true), addArr: addArr.for({ stream: ["__patternResult", "addArr"] }, true), addStr: addStr.for({ stream: ["__patternResult", "addStr"] }, true), addSection: addSection.for({ stream: ["__patternResult", "addSection"] }, true) };
}, {
    type: "object",
    properties: {
        log: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        log: {
            type: "array",
            items: {
                type: "string"
            }
        },
        addUnion: {
            $ref: "#/$defs/UnionEv",
            asCell: ["stream"]
        },
        addArr: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["stream"]
        },
        addStr: {
            type: "string",
            asCell: ["stream"]
        },
        addSection: {
            $ref: "#/$defs/SectionEv",
            asCell: ["stream"]
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["log", "addUnion", "addArr", "addStr", "addSection", "$NAME"],
    $defs: {
        SectionEv: {
            type: "object",
            properties: {
                base: {
                    type: "string"
                },
                extra: {
                    type: "object",
                    properties: {
                        z: {
                            type: "number"
                        }
                    },
                    required: ["z"],
                    asCell: ["cell"]
                }
            },
            required: ["base", "extra"]
        },
        UnionEv: {
            anyOf: [{
                    type: "object",
                    properties: {
                        kind: {
                            type: "string",
                            "enum": ["a"]
                        },
                        a: {
                            type: "number"
                        }
                    },
                    required: ["kind", "a"]
                }, {
                    type: "object",
                    properties: {
                        kind: {
                            type: "string",
                            "enum": ["b"]
                        },
                        b: {
                            type: "string"
                        }
                    },
                    required: ["kind", "b"]
                }]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_hfaa598c7156f,
    __cfHandler_h945fffca7161,
    __cfHandler_hc7858bec2146,
    __cfHandler_h8b5b8b11d10a,
    __cfHandler_1: __cfHandler_hfaa598c7156f,
    __cfHandler_2: __cfHandler_h945fffca7161,
    __cfHandler_3: __cfHandler_hc7858bec2146,
    __cfHandler_4: __cfHandler_h8b5b8b11d10a
});
