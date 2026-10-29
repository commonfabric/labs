function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Profile {
    name: string;
    avatar?: string;
}
interface BadgeState {
    profileInput?: Profile;
}
const __cfLift_1 = __cfHelpers.lift<{
    profileInput?: Profile | undefined;
    profileWish: {
        result: Profile | undefined;
    };
}, Profile | undefined>(({ profileInput, profileWish }) => profileInput ?? profileWish.result, {
    type: "object",
    properties: {
        profileInput: {
            $ref: "#/$defs/Profile"
        },
        profileWish: {
            type: "object",
            properties: {
                result: {
                    $ref: "#/$defs/Profile"
                }
            }
        }
    },
    required: ["profileWish"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                avatar: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            type: "undefined"
        }, {
            $ref: "#/$defs/Profile"
        }],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                avatar: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: binding-attr-nullish-wish-fallback
// Verifies: a nullish-coalescing binary at a bidirectional JSX binding
//   position — optional pattern input falling back to a wish() result —
//   lowers without crashing the compute-wrap invariant (lunch-poll PR #4928
//   shape 3, JSX-attribute form):
//   <cf-profile-badge $profile={profileInput ?? profileWish.result} />
// Context: regression companion to the builder-argument computation
//   diagnostic — the JSX-attribute form is supported; only the builder-call
//   argument form requires the hoist diagnostic.
export default pattern((__cf_pattern_input) => {
    const profileInput = __cf_pattern_input.key("profileInput");
    const profileWish = wish<Profile>({ query: "#profile" }, {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            avatar: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __cfHelpers.JSONSchema).for("profileWish", true);
    return {
        [UI]: (<div>
        <cf-profile-badge $profile={__cfLift_1({
            profileInput: profileInput,
            profileWish: {
                result: profileWish.key("result")
            }
        })}/>
      </div>),
    };
}, {
    type: "object",
    properties: {
        profileInput: {
            $ref: "#/$defs/Profile"
        }
    },
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                avatar: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
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
    __cfLift_1
});
