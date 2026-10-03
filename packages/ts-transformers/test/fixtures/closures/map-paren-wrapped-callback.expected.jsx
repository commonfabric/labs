function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Row {
    label: string;
}
const __cfPattern_he1be81448b35 = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return r.key("label");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: map-paren-wrapped-callback
// Verifies: a parenthesized inline map callback lowers exactly like its bare
//   spelling — rows.map(((r) => r.label)) → rows.mapWithPattern(pattern(...))
// Context: paren-invariance (target spec §5.7) at the extraction seam; a blind
//   arguments[0] read here once skipped the lowering entirely, emitting a raw
//   reactive .map that throws at runtime
export default pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const out = rows.mapWithPattern(__cfPattern_he1be81448b35, {}).for("out", true);
    return { out };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        out: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["out"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_he1be81448b35,
    __cfPattern_1: __cfPattern_he1be81448b35
});
