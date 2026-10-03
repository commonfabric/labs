function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { action, type Default, NAME, pattern, type Stream, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// The verb input contract (docs/history/plans/verb-input-contract.md): the served
// event schema is the authored interface, whether or not the body reads a
// field. `title` is read; `done` is declared and never read; `peer` is a
// declared, never-read reference and keeps a reference marker at the least
// capability. A recursive member exercises the shrink's cycle fallback.
interface PeerNode {
    name: string;
    next: PeerNode | null;
}
interface ProbeEvent {
    /** Read by the body. */
    title: string;
    /** Declared and never read. */
    done: boolean;
    /** A declared, never-read reference. */
    peer: Writable<PeerNode>;
}
interface ProbeResult {
    count: number;
}
interface ProbeOutput {
    [NAME]: string;
    entries: string[];
    add: Stream<ProbeEvent, ProbeResult>;
}
const __cfHandler_h8bce45e0dabd = __cfHelpers.handler({
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        done: {
            type: "boolean"
        },
        peer: {
            $ref: "#/$defs/PeerNode",
            asCell: ["opaque"]
        }
    },
    required: ["title", "done", "peer"],
    $defs: {
        PeerNode: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                next: {
                    anyOf: [{
                            $ref: "#/$defs/PeerNode"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["name", "next"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                type: "string"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    required: ["entries"]
} as const satisfies __cfHelpers.JSONSchema, (event, { entries }) => {
    entries.push(event.title);
    return { count: (entries.get() ?? []).length };
}, { resultSchema: {
        type: "object",
        properties: {
            count: {
                type: "number"
            }
        },
        required: ["count"]
    } as const satisfies __cfHelpers.JSONSchema });
export default pattern((__cf_pattern_input) => {
    const entries = __cf_pattern_input.key("entries");
    const add = __cfHandler_h8bce45e0dabd({
        entries: entries
    }).for({ stream: "add" }, true);
    return { [NAME]: "probe", entries: entries.for(["__patternResult", "entries"], true), add: add.for({ stream: ["__patternResult", "add"] }, true) };
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                type: "string"
            },
            "default": [],
            asCell: ["cell"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                type: "string"
            }
        },
        add: {
            $ref: "#/$defs/ProbeEvent",
            asCell: ["stream"]
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["entries", "add", "$NAME"],
    $defs: {
        ProbeEvent: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Read by the body."
                },
                done: {
                    type: "boolean",
                    description: "Declared and never read."
                },
                peer: {
                    $ref: "#/$defs/PeerNode",
                    asCell: ["cell"],
                    description: "A declared, never-read reference."
                }
            },
            required: ["title", "done", "peer"]
        },
        PeerNode: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                next: {
                    anyOf: [{
                            $ref: "#/$defs/PeerNode"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["name", "next"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_h8bce45e0dabd,
    __cfHandler_1: __cfHandler_h8bce45e0dabd
});
