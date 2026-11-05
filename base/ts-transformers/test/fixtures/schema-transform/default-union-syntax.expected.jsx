function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { DeepDefault, Default, NAME, pattern, toSchema, } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Options {
    theme: string;
    profile: {
        name: string;
        email: string;
    };
}
interface Input {
    title: string | Default<"">;
    subtitle: string | Default<null>;
    options: Options | DeepDefault<{
        theme: "dark";
        profile: {
            name: "Ada";
        };
    }>;
}
const inputSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": ""
        },
        subtitle: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }],
            "default": null
        },
        options: {
            $ref: "#/$defs/Options",
            "default": {
                theme: "dark",
                profile: {
                    name: "Ada"
                }
            },
            properties: {
                theme: {
                    "default": "dark"
                },
                profile: {
                    "default": {
                        name: "Ada"
                    },
                    properties: {
                        name: {
                            "default": "Ada"
                        }
                    }
                }
            }
        }
    },
    required: ["title", "subtitle", "options"],
    $defs: {
        Options: {
            type: "object",
            properties: {
                theme: {
                    type: "string"
                },
                profile: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        email: {
                            type: "string"
                        }
                    },
                    required: ["name", "email"]
                }
            },
            required: ["theme", "profile"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: default-union-syntax
// Verifies: union Default and DeepDefault syntax is preserved through schema-transform fixtures
export default pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const subtitle = __cf_pattern_input.key("subtitle");
    const options = __cf_pattern_input.key("options");
    return ({
        [NAME]: title,
        title,
        subtitle,
        options,
    });
}, inputSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        title: {
            type: "string"
        },
        subtitle: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        options: {
            $ref: "#/$defs/Options"
        }
    },
    required: ["$NAME", "title", "subtitle", "options"],
    $defs: {
        Options: {
            type: "object",
            properties: {
                theme: {
                    type: "string"
                },
                profile: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        },
                        email: {
                            type: "string"
                        }
                    },
                    required: ["name", "email"]
                }
            },
            required: ["theme", "profile"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
