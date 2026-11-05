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
}
interface CoreOutput extends RowOutput {
    extra: string;
}
interface WrapperOutput extends RowOutput {
    label: string;
    nested: string;
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
// FIXTURE: pattern-body-factory-result-key-access
// Verifies: `row[K]`, where K is a well-known key (NAME, UI, VIEWS) and `row`
// is a pattern-factory result bound in the pattern body, lowers to
// `row.key(__cfHelpers.K)` with no lift
//   [NAME]: row[NAME]          → row.key(__cfHelpers.NAME)
//   label: row[NAME]           → row.key(__cfHelpers.NAME)
//   row[VIEWS].row.rendered    → row.key(__cfHelpers.VIEWS, "row", "rendered")
//   <div>{row[UI]}</div>       → <div>{row.key(__cfHelpers.UI)}</div>
// Context: the same reads inside a collection callback are covered by
// map-pattern-factory-result-key-access; the two contexts lower alike
export default pattern((__cf_pattern_input) => {
    const piece = __cf_pattern_input.key("piece");
    const row = Row({ piece });
    return {
        [NAME]: row.key(__cfHelpers.NAME),
        [VIEWS]: row.key(__cfHelpers.VIEWS),
        rendered: row.key("rendered"),
        label: row.key(__cfHelpers.NAME),
        nested: row.key(__cfHelpers.VIEWS, "row", "rendered"),
        [UI]: <div>{row.key(__cfHelpers.UI)}</div>,
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
        label: {
            type: "string"
        },
        nested: {
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
    required: ["label", "nested", "$UI", "$NAME", "$VIEWS", "rendered"],
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
