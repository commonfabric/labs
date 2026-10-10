function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { NAME, pattern, UI, VIEWS, type VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface RowInput {
    piece: string;
}
interface RowView {
    rendered: string;
}
interface RowOutput extends RowView {
    [UI]: VNode;
    [NAME]: string;
    [VIEWS]: {
        row: RowView;
    };
    extra: string;
}
interface Output {
    shout: string;
    unrendered: boolean;
    viewless: boolean;
}
const Row = pattern((input) => {
    const view = { rendered: input.key("piece") };
    return {
        [UI]: <div />,
        [NAME]: input.key("piece"),
        [VIEWS]: { row: view },
        ...view,
        extra: input.key("piece"),
    };
}, {
    type: "object",
    properties: {
        piece: {
            type: "string"
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        extra: {
            type: "string"
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        },
        $NAME: {
            type: "string"
        },
        $VIEWS: {
            type: "object",
            properties: {
                row: {
                    $ref: "#/$defs/RowView"
                }
            },
            required: ["row"]
        },
        rendered: {
            type: "string"
        }
    },
    required: ["extra", "$UI", "$NAME", "$VIEWS", "rendered"],
    $defs: {
        RowView: {
            type: "object",
            properties: {
                rendered: {
                    type: "string"
                }
            },
            required: ["rendered"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    row: RowOutput;
}, string>(({ row }) => row[__cfHelpers.NAME] + "!", {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                $NAME: {
                    type: "string"
                }
            },
            required: ["$NAME"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    row: RowOutput;
}, boolean>(({ row }) => row[__cfHelpers.UI] === undefined, {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    row: RowOutput;
}, boolean>(({ row }) => row[__cfHelpers.VIEWS] === undefined, {
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                $VIEWS: {
                    type: "object",
                    properties: {
                        row: {
                            $ref: "#/$defs/RowView"
                        }
                    },
                    required: ["row"]
                }
            },
            required: ["$VIEWS"]
        }
    },
    required: ["row"],
    $defs: {
        RowView: {
            type: "object",
            properties: {
                rendered: {
                    type: "string"
                }
            },
            required: ["rendered"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: pattern-body-well-known-key-computation
// Verifies: a computation over `row[K]`, K a well-known key, lifts with an
// input schema that declares only that key of `row`
//   row[NAME] + "!"          → lift over { row: { $NAME } }
//   row[UI] === undefined    → lift over { row: { $UI } }
//   row[VIEWS] === undefined → lift over { row: { $VIEWS } }
// Context: the lift body reads `row[__cfHelpers.K]`; `rendered` and `extra`
// stay out of every input schema
export default pattern((__cf_pattern_input) => {
    const piece = __cf_pattern_input.key("piece");
    const row = Row({ piece });
    return {
        shout: __cfLift_1({ row: row }).for(["__patternResult", "shout"], true),
        unrendered: __cfLift_2({ row: row }).for(["__patternResult", "unrendered"], true),
        viewless: __cfLift_3({ row: row }).for(["__patternResult", "viewless"], true)
    };
}, {
    type: "object",
    properties: {
        piece: {
            type: "string"
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        shout: {
            type: "string"
        },
        unrendered: {
            type: "boolean"
        },
        viewless: {
            type: "boolean"
        }
    },
    required: ["shout", "unrendered", "viewless"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Row,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
