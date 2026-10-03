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
 * FIXTURE: nested-writable-pattern-branches
 * Verifies: pattern-owned maps on explicit Writable inputs stay pattern-lowered
 * across mixed authored ifElse helpers, implicit JSX ternaries, nested maps,
 * and handler closures that capture values from several upper scopes.
 * Expected transform:
 * - state.sections.map(...) and section.tasks.map(...) become mapWithPattern()
 * - authored ifElse predicates and branches lower uniformly
 * - nested ternaries inside task/tag callbacks lower without extra lift-applied noise
 * - handler captures preserve section/task/index/local Writable references
 */
import { computed, handler, ifElse, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Task {
    id: string;
    label: string;
    done: boolean;
    tags: string[];
    note?: string;
}
interface Section {
    id: string;
    title: string;
    expanded: boolean;
    accent?: string;
    tasks: Task[];
}
// [TRANSFORM] handler: event schema (true=unknown) and state schema injected
const selectTask = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        selectedTaskId: {
            type: ["string", "undefined"]
        },
        hoveredSectionId: {
            type: ["string", "undefined"]
        },
        sectionId: {
            type: "string"
        },
        taskId: {
            type: "string"
        },
        sectionIndex: {
            type: "number"
        },
        taskIndex: {
            type: "number"
        }
    },
    required: ["selectedTaskId", "hoveredSectionId", "sectionId", "taskId", "sectionIndex", "taskIndex"]
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
const __cfLift_h684f660abd51 = __cfHelpers.lift<{
    state: {
        sections: __cfHelpers.ReadonlyCell<unknown[]>;
    };
}, boolean>(({ state }) => state.sections.get().length > 0, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                sections: {
                    type: "array",
                    items: {
                        type: "unknown"
                    },
                    asCell: ["readonly"]
                }
            },
            required: ["sections"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h78fd377906a6 = __cfHelpers.lift<{
    task: {
        note?: string | undefined;
    };
}, boolean>(({ task }) => task.note !== undefined, {
    type: "object",
    properties: {
        task: {
            type: "object",
            properties: {
                note: {
                    type: "string"
                }
            }
        }
    },
    required: ["task"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h45179e144554 = __cfHelpers.lift<{
    tagIndex: number;
    taskIndex: number;
}, boolean>(({ tagIndex, taskIndex }) => tagIndex === taskIndex, {
    type: "object",
    properties: {
        tagIndex: {
            type: "number"
        },
        taskIndex: {
            type: "number"
        }
    },
    required: ["tagIndex", "taskIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_heaa3a32a7fcf = __cfHelpers.pattern(__cf_pattern_input => {
    const tag = __cf_pattern_input.key("element");
    const tagIndex = __cf_pattern_input.key("index");
    const taskIndex = __cf_pattern_input.key("params", "taskIndex");
    const section = __cf_pattern_input.key("params", "section");
    const state = __cf_pattern_input.key("params", "state");
    const task = __cf_pattern_input.key("params", "task");
    return (<span>
                            {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h45179e144554({
            tagIndex: tagIndex,
            taskIndex: taskIndex
        }), `${section.key("title")}:${tag}`, __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.unless({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, state.key("showCompleted"), !task.key("done")), tag, ""))}
                          </span>);
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
                taskIndex: {
                    type: "number"
                },
                section: {
                    type: "object",
                    properties: {
                        title: {
                            type: "string"
                        }
                    },
                    required: ["title"]
                },
                state: {
                    type: "object",
                    properties: {
                        showCompleted: {
                            type: "boolean"
                        }
                    },
                    required: ["showCompleted"]
                },
                task: {
                    type: "object",
                    properties: {
                        done: {
                            type: "boolean"
                        }
                    },
                    required: ["done"]
                }
            },
            required: ["taskIndex", "section", "state", "task"]
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
const __cfPattern_he515ddba3102 = __cfHelpers.pattern(__cf_pattern_input => {
    const task = __cf_pattern_input.key("element");
    const taskIndex = __cf_pattern_input.key("index");
    const selectedTaskId = __cf_pattern_input.key("params", "selectedTaskId");
    const hoveredSectionId = __cf_pattern_input.key("params", "hoveredSectionId");
    const section = __cf_pattern_input.key("params", "section");
    const sectionIndex = __cf_pattern_input.key("params", "sectionIndex");
    const state = __cf_pattern_input.key("params", "state");
    return (<div>
                        <button type="button" onClick={selectTask({
            selectedTaskId,
            hoveredSectionId,
            sectionId: section.key("id"),
            taskId: task.key("id"),
            sectionIndex,
            taskIndex,
        })}>
                          {/* [TRANSFORM] ternary lowered: task.done ? <span>...</span> : ifElse(...) → ifElse(task.done, ..., ...) */}
                          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, task.key("done"), <span>{task.key("label")}</span>, ifElse({
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfHelpers.when({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, __cfLift_h78fd377906a6({ task: {
                note: task.key("note")
            } }), task.key("note") !== ""), <strong>{task.key("label")}</strong>, <em>{task.key("label")}</em>))}
                        </button>
                        {/* [TRANSFORM] .map() → mapWithPattern: task.tags is reactive pattern-owned data (nested inside sections map) */}
                        {/* [TRANSFORM] closure captures: taskIndex, section, state, task (all via params) */}
                        {/* [TRANSFORM] ternary lowered: tagIndex===taskIndex ? `${section.title}:${tag}` : (showCompleted||!task.done ? tag : "") */}
                        {task.key("tags").mapWithPattern(__cfPattern_heaa3a32a7fcf, {
            taskIndex: taskIndex,
            section: {
                title: section.key("title")
            },
            state: {
                showCompleted: state.key("showCompleted")
            },
            task: {
                done: task.key("done")
            }
        })}
                      </div>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Task"
        },
        index: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                selectedTaskId: {
                    type: ["string", "undefined"],
                    asCell: ["readonly"]
                },
                hoveredSectionId: {
                    type: ["string", "undefined"],
                    asCell: ["readonly"]
                },
                section: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        },
                        title: {
                            type: "string"
                        }
                    },
                    required: ["id", "title"]
                },
                sectionIndex: {
                    type: "number"
                },
                state: {
                    type: "object",
                    properties: {
                        showCompleted: {
                            type: "boolean"
                        }
                    },
                    required: ["showCompleted"]
                }
            },
            required: ["selectedTaskId", "hoveredSectionId", "section", "sectionIndex", "state"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Task: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                note: {
                    type: "string"
                }
            },
            required: ["id", "label", "done", "tags"]
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
const __cfLift_hdc8e33263517 = __cfHelpers.lift<{
    section: {
        tasks: {
            length: number;
        };
        title: string;
    };
}, __cfHelpers.JSXElement>(({ section }) => 
// [TRANSFORM] ternary preserved inside the ifElse(expanded) false branch:
//   section.tasks.length > 0 ? <small>...collapsed</small> : <small>empty</small>
//   → plain local ternary inside the JSX branch
section.tasks.length > 0
    ? <small>{section.title} collapsed</small>
    : <small>empty</small>, {
    type: "object",
    properties: {
        section: {
            type: "object",
            properties: {
                tasks: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                },
                title: {
                    type: "string"
                }
            },
            required: ["tasks", "title"]
        }
    },
    required: ["section"]
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_h4dcc24e464fa = __cfHelpers.pattern(__cf_pattern_input => {
    const section = __cf_pattern_input.key("element");
    const sectionIndex = __cf_pattern_input.key("index");
    const state = __cf_pattern_input.key("params", "state");
    const selectedTaskId = __cf_pattern_input.key("params", "selectedTaskId");
    const hoveredSectionId = __cf_pattern_input.key("params", "hoveredSectionId");
    return (<section>
                <h2 style={{
        // [TRANSFORM] ternary lowered: section.accent ? section.accent : state.globalAccent → ifElse(...)
        color: __cfHelpers.ifElse({
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, section.key("accent"), section.key("accent"), state.key("globalAccent")),
    }}>
                  {section.key("title")}
                </h2>
                {/* [TRANSFORM] ifElse: schema-injected authored ifElse(section.expanded, ..., ...) */}
                {ifElse({
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, section.key("expanded"), <div>
                    {/* [TRANSFORM] .map() → mapWithPattern: section.tasks is reactive pattern-owned data */}
                    {/* [TRANSFORM] closure captures: selectedTaskId, hoveredSectionId, section, sectionIndex, state (all via params) */}
                    {section.key("tasks").mapWithPattern(__cfPattern_he515ddba3102, {
                selectedTaskId: selectedTaskId,
                hoveredSectionId: hoveredSectionId,
                section: {
                    id: section.key("id"),
                    title: section.key("title")
                },
                sectionIndex: sectionIndex,
                state: {
                    showCompleted: state.key("showCompleted")
                }
            })}
                  </div>, __cfLift_hdc8e33263517({ section: {
                tasks: {
                    length: section.key("tasks", "length")
                },
                title: section.key("title")
            } }))}
              </section>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Section"
        },
        index: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        globalAccent: {
                            type: "string"
                        },
                        showCompleted: {
                            type: "boolean"
                        }
                    },
                    required: ["globalAccent", "showCompleted"]
                },
                selectedTaskId: {
                    type: ["string", "undefined"],
                    asCell: ["readonly"]
                },
                hoveredSectionId: {
                    type: ["string", "undefined"],
                    asCell: ["readonly"]
                }
            },
            required: ["state", "selectedTaskId", "hoveredSectionId"]
        }
    },
    required: ["element", "params"],
    $defs: {
        Section: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                expanded: {
                    type: "boolean"
                },
                accent: {
                    type: "string"
                },
                tasks: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Task"
                    }
                }
            },
            required: ["id", "title", "expanded", "tasks"]
        },
        Task: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                note: {
                    type: "string"
                }
            },
            required: ["id", "label", "done", "tags"]
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
// [TRANSFORM] pattern: type param stripped; input+output schemas appended after callback
export default pattern((state) => {
    // [TRANSFORM] new Writable: schema arg injected; undefined default added for optional type
    const selectedTaskId = new Writable<string | undefined>(undefined, {
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("selectedTaskId", true);
    // [TRANSFORM] new Writable: schema arg injected; undefined default added for optional type
    const hoveredSectionId = new Writable<string | undefined>(undefined, {
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("hoveredSectionId", true);
    // [TRANSFORM] computed() -> lift(): captures state.sections (asCell — Writable<Section[]>)
    const hasSections = __cfLift_h684f660abd51({ state: {
            sections: state.key("sections")
        } }).for("hasSections", true);
    return {
        [UI]: (<div>
        {/* [TRANSFORM] ifElse: schema-injected authored ifElse(hasSections, ..., ...) */}
        {ifElse({
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, hasSections, <div>
            {/* [TRANSFORM] .map() → mapWithPattern: state.sections is Writable<Section[]> — reactive, pattern context */}
            {/* [TRANSFORM] closure captures: state (reactive), selectedTaskId (Writable), hoveredSectionId (Writable) */}
            {state.key("sections").mapWithPattern(__cfPattern_h4dcc24e464fa, {
                state: {
                    globalAccent: state.key("globalAccent"),
                    showCompleted: state.key("showCompleted")
                },
                selectedTaskId: selectedTaskId,
                hoveredSectionId: hoveredSectionId
            })}
          </div>, 
        // [TRANSFORM] false-branch of ifElse(hasSections): ternary showCompleted ? "No completed sections" : "No sections"
        //   → local ifElse(...) inside the <p> JSX expression
        <p>{__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["No completed sections", "No sections"]
        } as const satisfies __cfHelpers.JSONSchema, state.key("showCompleted"), "No completed sections", "No sections")}</p>)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        sections: {
            type: "array",
            items: {
                $ref: "#/$defs/Section"
            },
            asCell: ["cell"]
        },
        showCompleted: {
            type: "boolean"
        },
        globalAccent: {
            type: "string"
        }
    },
    required: ["sections", "showCompleted", "globalAccent"],
    $defs: {
        Section: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                expanded: {
                    type: "boolean"
                },
                accent: {
                    type: "string"
                },
                tasks: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Task"
                    }
                }
            },
            required: ["id", "title", "expanded", "tasks"]
        },
        Task: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                },
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                },
                note: {
                    type: "string"
                }
            },
            required: ["id", "label", "done", "tags"]
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
    selectTask,
    __cfLift_h684f660abd51,
    __cfLift_h78fd377906a6,
    __cfLift_h45179e144554,
    __cfPattern_heaa3a32a7fcf,
    __cfPattern_he515ddba3102,
    __cfLift_hdc8e33263517,
    __cfPattern_h4dcc24e464fa,
    __cfLift_1: __cfLift_h684f660abd51,
    __cfLift_2: __cfLift_h78fd377906a6,
    __cfLift_3: __cfLift_h45179e144554,
    __cfPattern_1: __cfPattern_heaa3a32a7fcf,
    __cfPattern_2: __cfPattern_he515ddba3102,
    __cfLift_4: __cfLift_hdc8e33263517,
    __cfPattern_3: __cfPattern_h4dcc24e464fa
});
