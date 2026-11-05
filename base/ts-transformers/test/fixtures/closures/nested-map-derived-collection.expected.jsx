function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Vote {
    optionId: string;
    voterName: string;
}
interface Option {
    id: string;
}
interface OptionTally {
    option: Option;
    voters: Array<{
        name: string;
    }>;
}
// FIXTURE: nested-map-derived-collection
// Verifies (CT-1778): a reactive collection produced by a non-reactive-origin helper
// over reactive parameters — `tallyOptions(options, votes): OptionTally[]` — is
// recognized as reactive at array-method-decision time, so a nested `.map` over a
// per-item field (`tally.voters.map(...)`) lowers to `.mapWithPattern` instead of being
// emitted raw (which throws "Reactive.map(fn) is no longer supported" at runtime,
// because the receiver is a Reactive). Before the fix the inner map raced the helper
// result's late lift-wrap registration and stayed raw.
//
// Covers both shapes:
//   - direct receiver: `ranked = tallyOptions(options, votes)`
//   - chained derivation: `enriched = enrichTallies(ranked)` (a derived const passed to
//     another helper), exercising the recursive provenance walk through const args.
const tallyOptions = __cfHardenFn((options: Option[], votes: Vote[]): OptionTally[] => options.map((option): OptionTally => ({
    option,
    voters: votes.map((v) => ({ name: v.voterName })),
})));
const enrichTallies = __cfHardenFn((tallies: OptionTally[]): OptionTally[] => tallies.map((t): OptionTally => ({ option: t.option, voters: t.voters })));
const __cfLift_1 = __cfHelpers.lift<{
    options: Option[];
    votes: Vote[];
}, OptionTally[]>(({ options, votes }) => tallyOptions(options, votes), {
    type: "object",
    properties: {
        options: {
            type: "array",
            items: {
                $ref: "#/$defs/Option"
            }
        },
        votes: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    voterName: {
                        type: "string"
                    }
                },
                required: ["voterName"]
            }
        }
    },
    required: ["options", "votes"],
    $defs: {
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/OptionTally"
    },
    $defs: {
        OptionTally: {
            type: "object",
            properties: {
                option: {
                    $ref: "#/$defs/Option"
                },
                voters: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["option", "voters"]
        },
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    ranked: OptionTally[];
}, OptionTally[]>(({ ranked }) => enrichTallies(ranked), {
    type: "object",
    properties: {
        ranked: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    option: {
                        $ref: "#/$defs/Option"
                    },
                    voters: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                },
                required: ["option", "voters"]
            }
        }
    },
    required: ["ranked"],
    $defs: {
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/OptionTally"
    },
    $defs: {
        OptionTally: {
            type: "object",
            properties: {
                option: {
                    $ref: "#/$defs/Option"
                },
                voters: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["option", "voters"]
        },
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const voter = __cf_pattern_input.key("element");
    return <span>{voter.key("name")}</span>;
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["element"]
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
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const tally = __cf_pattern_input.key("element");
    return (<div>{tally.key("voters").mapWithPattern(__cfPattern_1)}</div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/OptionTally"
        }
    },
    required: ["element"],
    $defs: {
        OptionTally: {
            type: "object",
            properties: {
                option: {
                    $ref: "#/$defs/Option"
                },
                voters: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["option", "voters"]
        },
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
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
const __cfPattern_3 = __cfHelpers.pattern(__cf_pattern_input => {
    const voter = __cf_pattern_input.key("element");
    return <span>{voter.key("name")}</span>;
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    },
    required: ["element"]
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
const __cfPattern_4 = __cfHelpers.pattern(__cf_pattern_input => {
    const tally = __cf_pattern_input.key("element");
    return (<div>{tally.key("voters").mapWithPattern(__cfPattern_3)}</div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/OptionTally"
        }
    },
    required: ["element"],
    $defs: {
        OptionTally: {
            type: "object",
            properties: {
                option: {
                    $ref: "#/$defs/Option"
                },
                voters: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    }
                }
            },
            required: ["option", "voters"]
        },
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
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
export default pattern((__cf_pattern_input) => {
    const votes = __cf_pattern_input.key("votes");
    const options = __cf_pattern_input.key("options");
    const ranked = __cfLift_1({
        options: options,
        votes: votes
    }).for("ranked", true);
    const enriched = __cfLift_2({ ranked: ranked }).for("enriched", true);
    return {
        [UI]: (<div>
          <div>
            {ranked.mapWithPattern(__cfPattern_2)}
          </div>
          <div>
            {enriched.mapWithPattern(__cfPattern_4)}
          </div>
        </div>),
    };
}, {
    type: "object",
    properties: {
        votes: {
            type: "array",
            items: {
                $ref: "#/$defs/Vote"
            }
        },
        options: {
            type: "array",
            items: {
                $ref: "#/$defs/Option"
            }
        }
    },
    required: ["votes", "options"],
    $defs: {
        Option: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        },
        Vote: {
            type: "object",
            properties: {
                optionId: {
                    type: "string"
                },
                voterName: {
                    type: "string"
                }
            },
            required: ["optionId", "voterName"]
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
    __cfLift_1,
    __cfLift_2,
    __cfPattern_1,
    __cfPattern_2,
    __cfPattern_3,
    __cfPattern_4
});
