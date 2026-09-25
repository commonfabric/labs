function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PollState {
    users: Default<string[], [
    ]>;
}
const __cfLift_h42f13f2d01f6 = __cfHelpers.lift<{
    userCount: number;
}, boolean>(({ userCount }) => userCount > 0, {
    type: "object",
    properties: {
        userCount: {
            type: "number"
        }
    },
    required: ["userCount"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: ternary-binary-condition-body-alias
// Verifies: a JSX ternary whose condition is a binary comparison over a
//   body-level alias of a reactive read lowers without crashing the
//   compute-wrap invariant (lunch-poll PR #4928 shape 1):
//   const userCount = users.length; ... {userCount > 0 ? <div/> : null}
//     -> ifElse(<derived boolean>, <branch>, null)
// Context: regression companion to the builder-argument computation
//   diagnostic — this shape is supported and must keep lowering cleanly.
export default pattern((__cf_pattern_input) => {
    const users = __cf_pattern_input.key("users");
    const userCount = users.key("length");
    return {
        [UI]: (<div>
        {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h42f13f2d01f6({ userCount: userCount }), <div>has users</div>, null)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        users: {
            type: "array",
            items: {
                type: "string"
            },
            "default": []
        }
    },
    required: ["users"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
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
    __cfLift_h42f13f2d01f6,
    __cfLift_1: __cfLift_h42f13f2d01f6
});
