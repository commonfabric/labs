function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    req: string;
    opt?: string;
    ud: string;
    renamed?: string;
    qOpt?: string;
}, { qOpt?: string | undefined; renamed?: string | undefined; ud?: string | undefined; opt?: string | undefined; req: string; }>(({ req, opt, ud, renamed, qOpt }) => ({
    req: req,
    ...(opt !== undefined && { opt: opt }),
    ...(ud !== undefined && { ud: ud }),
    ...(renamed !== undefined && { renamed: renamed }),
    ...(qOpt !== undefined && { qOpt: qOpt }),
}), {
    type: "object",
    properties: {
        req: {
            type: "string"
        },
        opt: {
            type: "string"
        },
        ud: {
            type: "string"
        },
        renamed: {
            type: "string"
        },
        qOpt: {
            type: "string"
        }
    },
    required: ["req", "ud"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        qOpt: {
            type: "string"
        },
        renamed: {
            type: "string"
        },
        ud: {
            type: "string"
        },
        opt: {
            type: "string"
        },
        req: {
            type: "string"
        }
    },
    required: ["req"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// FIXTURE: pattern-optional-destructured-capture
// Verifies: an optional pattern input (`opt?`) destructured and captured in a
//   closure is emitted optional in the derived lift's input schema (so it does
//   not gate the lift), while `ud: T | undefined` (no `?`) stays required. A
//   renamed binding tracks its source property's optionality whether the source
//   key is an identifier (`ren: renamed`) or a string literal (`"q-opt": qOpt`).
export default pattern((__cf_pattern_input) => {
    const req = __cf_pattern_input.key("req");
    const opt = __cf_pattern_input.key("opt");
    const ud = __cf_pattern_input.key("ud");
    const renamed = __cf_pattern_input.key("ren");
    const qOpt = __cf_pattern_input.key("q-opt");
    const body = __cfLift_1({
        req: req,
        opt: opt,
        ud: ud,
        renamed: renamed,
        qOpt: qOpt
    }).for("body", true);
    return <div>{body}</div>;
}, {
    type: "object",
    properties: {
        req: {
            type: "string"
        },
        opt: {
            type: "string"
        },
        ud: {
            type: ["string", "undefined"]
        },
        ren: {
            type: "string"
        },
        "q-opt": {
            type: "string"
        }
    },
    required: ["req", "ud"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
