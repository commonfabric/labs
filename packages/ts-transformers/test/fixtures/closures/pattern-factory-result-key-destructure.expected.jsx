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
interface RowOutput {
    [UI]: VNode;
    [NAME]: string;
    [VIEWS]: {
        row: RowView;
    };
}
const Row = pattern((input) => ({
    [UI]: <div />,
    [NAME]: input.key("piece"),
    [VIEWS]: { row: { rendered: input.key("piece") } },
}), {
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
        }
    },
    required: ["$UI", "$NAME", "$VIEWS"],
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
// FIXTURE: pattern-factory-result-key-destructure
// Verifies: destructuring well-known keys off a pattern-factory result keys
// each binding by the key's string
//   { [NAME]: name }   → .key("$NAME")
//   { [VIEWS]: views } → .key("$VIEWS")
//   { [UI]: ui }       → .key("$UI")
export default pattern((__cf_pattern_input) => {
    const piece = __cf_pattern_input.key("piece");
    const __cf_destructure_1 = Row({ piece }), name = __cf_destructure_1.key("$NAME").for("name", true), views = __cf_destructure_1.key("$VIEWS").for("views", true), ui = __cf_destructure_1.key("$UI").for("ui", true);
    return { [NAME]: name, [VIEWS]: views, [UI]: ui };
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
        }
    },
    required: ["$UI", "$NAME", "$VIEWS"],
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
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Row
});
