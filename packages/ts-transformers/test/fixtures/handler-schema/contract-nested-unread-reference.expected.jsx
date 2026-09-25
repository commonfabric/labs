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
// FIXTURE: contract-nested-unread-reference
// Verifies: a declared, never-read field whose subtree holds a reference
// serves its authored structure with the nested reference OPAQUE — the
// contract names it, the grant confers nothing (verb-input-contract.md).
interface Inner {
    n: number;
}
interface Box {
    label: string;
    inner: Writable<Inner>;
}
interface Ev {
    title: string;
    box: Box;
}
interface Out {
    [NAME]: string;
    log: string[];
    add: Stream<Ev, {
        ok: boolean;
    }>;
}
const __cfHandler_h2b697611607a = __cfHelpers.handler({
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        box: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                inner: {
                    $ref: "#/$defs/Inner",
                    asCell: ["opaque"]
                }
            },
            required: ["label", "inner"]
        }
    },
    required: ["title", "box"],
    $defs: {
        Inner: {
            type: "object",
            properties: {
                n: {
                    type: "number"
                }
            },
            required: ["n"]
        }
    }
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
    log?.push(event.title);
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
    const add = __cfHandler_h2b697611607a({
        log: log
    }).for({ stream: "add" }, true);
    return { [NAME]: "p", log: log!.for(["__patternResult", "log"], true), add: add.for({ stream: ["__patternResult", "add"] }, true) };
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
        add: {
            $ref: "#/$defs/Ev",
            asCell: ["stream"]
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["log", "add", "$NAME"],
    $defs: {
        Ev: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                box: {
                    $ref: "#/$defs/Box"
                }
            },
            required: ["title", "box"]
        },
        Box: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                },
                inner: {
                    $ref: "#/$defs/Inner",
                    asCell: ["cell"]
                }
            },
            required: ["label", "inner"]
        },
        Inner: {
            type: "object",
            properties: {
                n: {
                    type: "number"
                }
            },
            required: ["n"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_h2b697611607a,
    __cfHandler_1: __cfHandler_h2b697611607a
});
