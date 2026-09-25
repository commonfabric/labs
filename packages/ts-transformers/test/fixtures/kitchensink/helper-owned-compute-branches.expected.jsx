function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * FIXTURE: helper-owned-compute-branches
 * Verifies: helper-owned branches inside computed() can mix compute-owned array
 * maps with reactive Writable captures without losing branch rewriting.
 * Expected transform:
 * - visibleProjects.map(...), project.badges.map(...), project.members.map(...),
 *   and plainPreview.map(...) remain plain Array.map() calls in compute context
 * - fallbackMembers.map(...) still lowers because it comes from a closed-over
 *   Writable array capture
 * - authored ifElse branches still lower safely around the mixed map behavior
 */
import { computed, ifElse, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Badge {
    text: string;
    active: boolean;
}
interface Project {
    id: string;
    name: string;
    archived: boolean;
    members: string[];
    badges: Badge[];
}
const __cfLift_hcc2204ac106f = __cfHelpers.lift<{
    state: {
        showArchived: boolean;
        projects: {
            archived: boolean;
        }[];
    };
}, Project[]>(({ state }) => state.showArchived
    ? state.projects
    : state.projects.filter((project) => !project.archived), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                showArchived: {
                    type: "boolean"
                },
                projects: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            archived: {
                                type: "boolean"
                            }
                        },
                        required: ["archived"]
                    }
                }
            },
            required: ["showArchived", "projects"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Project"
    },
    $defs: {
        Project: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                archived: {
                    type: "boolean"
                },
                members: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                badges: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Badge"
                    }
                }
            },
            required: ["id", "name", "archived", "members", "badges"]
        },
        Badge: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["text", "active"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h6fc8d8628c41 = __cfHelpers.lift<{
    memberIndex: number;
}, boolean>(({ memberIndex }) => memberIndex === 0, {
    type: "object",
    properties: {
        memberIndex: {
            type: "number"
        }
    },
    required: ["memberIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hdf4bcefb52cf = __cfHelpers.lift<{
    project: {
        name: string;
    };
    member: string;
}, string>(({ project, member }) => `${project.name}-${member}`, {
    type: "object",
    properties: {
        project: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        },
        member: {
            type: "string"
        }
    },
    required: ["project", "member"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h17b323b2c208 = __cfHelpers.pattern(__cf_pattern_input => {
    const member = __cf_pattern_input.key("element");
    const memberIndex = __cf_pattern_input.key("index");
    const project = __cf_pattern_input.params.project;
    return (<small>
              {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h6fc8d8628c41({ memberIndex: memberIndex }), __cfLift_hdf4bcefb52cf({
        project: {
            name: project.name
        },
        member: member
    }), member)}
            </small>);
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        },
        index: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                project: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"]
                }
            },
            required: ["project"]
        }
    },
    required: ["element", "params"]
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
const __cfLift_hceda935cd7a2 = __cfHelpers.lift<{
    visibleProjects: {
        name: string;
        badges: {
            active: boolean;
            text: string;
        }[];
        members: string[];
    }[];
    state: {
        prefix: string;
    };
    fallbackMembers: __cfHelpers.ReadonlyCell<string[]>;
}, (__cfHelpers.VNode | __cfHelpers.UIRenderable)[]>(({ visibleProjects, state, fallbackMembers }) => 
// [TRANSFORM] .map() stays plain: visibleProjects is a captured computed input, plain inside this compute
visibleProjects.map((project, projectIndex) => {
    // [TRANSFORM] .map() stays plain: ["alpha","beta"] is a literal array
    const plainPreview = ["alpha", "beta"].map((label, labelIndex) => `${project.name}-${labelIndex}-${label}`);
    // [TRANSFORM] ifElse: schema args injected on authored ifElse
    return ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, project.badges.length > 0, <div>
          <h3>{project.name}</h3>
          {/* [TRANSFORM] .map() stays plain: project.badges is compute-owned data inside computed */}
          {project.badges.map((badge, badgeIndex) => (<span>
              {badge.active
                ? `${state.prefix}${badge.text}-${projectIndex}`
                : badgeIndex === 0
                    ? `${project.name}:${badge.text}`
                    : ""}
            </span>))}
          {/* [TRANSFORM] .map() → mapWithPattern: fallbackMembers is a Writable (reactive Cell), lowered even inside computed */}
          {fallbackMembers.mapWithPattern(__cfPattern_h17b323b2c208, {
            project: {
                name: project.name
            }
        })}
          {/* [TRANSFORM] .map() stays plain: plainPreview is a local literal array */}
          {plainPreview.map((label) => <i>{label}</i>)}
        </div>, <div>
          {/* [TRANSFORM] .map() stays plain: project.members is compute-owned data inside computed */}
          {project.members.map((member, memberIndex) => (<span>
              {memberIndex === projectIndex
                ? `${state.prefix}${member}`
                : member}
            </span>))}
        </div>);
}), {
    type: "object",
    properties: {
        visibleProjects: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    badges: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                active: {
                                    type: "boolean"
                                },
                                text: {
                                    type: "string"
                                }
                            },
                            required: ["active", "text"]
                        }
                    },
                    members: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["name", "badges", "members"]
            }
        },
        state: {
            type: "object",
            properties: {
                prefix: {
                    type: "string"
                }
            },
            required: ["prefix"]
        },
        fallbackMembers: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["readonly"]
        }
    },
    required: ["visibleProjects", "state", "fallbackMembers"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        anyOf: [{
                $ref: "https://commonfabric.org/schemas/vnode.json"
            }, {
                $ref: "#/$defs/UIRenderable"
            }]
    },
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
// [TRANSFORM] pattern: type param stripped; input+output schemas appended after callback
export default pattern((state) => {
    // [TRANSFORM] new Writable: schema arg injected
    const fallbackMembers = new Writable(["ops", "sales"], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema).for("fallbackMembers", true);
    // [TRANSFORM] computed() -> lift(): captures state.showArchived, state.projects
    const visibleProjects = __cfLift_hcc2204ac106f({ state: {
            showArchived: state.key("showArchived"),
            projects: state.key("projects")
        } }).for("visibleProjects", true);
    // [TRANSFORM] computed() -> lift(): captures visibleProjects (asOpaque), state.prefix, fallbackMembers (asCell — Writable)
    const rows = __cfLift_hceda935cd7a2({
        visibleProjects: visibleProjects,
        state: {
            prefix: state.key("prefix")
        },
        fallbackMembers: fallbackMembers
    }).for("rows", true);
    return {
        [UI]: <div>{rows}</div>,
    };
}, {
    type: "object",
    properties: {
        projects: {
            type: "array",
            items: {
                $ref: "#/$defs/Project"
            }
        },
        prefix: {
            type: "string"
        },
        showArchived: {
            type: "boolean"
        }
    },
    required: ["projects", "prefix", "showArchived"],
    $defs: {
        Project: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                archived: {
                    type: "boolean"
                },
                members: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                badges: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Badge"
                    }
                }
            },
            required: ["id", "name", "archived", "members", "badges"]
        },
        Badge: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["text", "active"]
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
    __cfLift_hcc2204ac106f,
    __cfLift_h6fc8d8628c41,
    __cfLift_hdf4bcefb52cf,
    __cfPattern_h17b323b2c208,
    __cfLift_hceda935cd7a2,
    __cfLift_1: __cfLift_hcc2204ac106f,
    __cfLift_2: __cfLift_h6fc8d8628c41,
    __cfLift_3: __cfLift_hdf4bcefb52cf,
    __cfPattern_1: __cfPattern_h17b323b2c208,
    __cfLift_4: __cfLift_hceda935cd7a2
});
