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
 * FIXTURE: nested-computed-output-maps
 * Verifies: nested computed outputs can flow back into later pattern-owned
 * maps while their inner compute-owned array maps stay plain, and callback
 * captures survive across multiple cloned callbacks.
 * Expected transform:
 * - laneLabels.map(...) lowers after calling a module-scope lift in pattern context
 * - visibleThreads.map(...), visibleComments.map(...), comment.reactions.map(...),
 *   and plainSeparators.map(...) remain plain Array.map() calls inside computed()
 * - liftedSeparators.map(...) lowers after calling that same module-scope lift
 *   inside the current compute callback
 * - reboundComments.map(...) lowers because a nested computed() re-wraps the
 *   local array inside the current compute callback
 * - threadRows.map(...) lowers once the flow re-enters pattern-owned UI
 * - closures preserve thread/comment indices, state.lane, and local Writables
 */
import { computed, handler, ifElse, lift, pattern, UI, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Comment {
    id: string;
    text: string;
    flagged: boolean;
    reactions: string[];
}
interface Thread {
    id: string;
    title: string;
    muted: boolean;
    comments: Comment[];
}
// [TRANSFORM] handler: event schema (true=unknown) and state schema injected
const jumpToComment = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        selectedCommentId: {
            type: ["string", "undefined"]
        },
        threadId: {
            type: "string"
        },
        commentId: {
            type: "string"
        },
        lane: {
            type: "string"
        },
        outerIndex: {
            type: "number"
        },
        innerIndex: {
            type: "number"
        }
    },
    required: ["selectedCommentId", "threadId", "commentId", "lane", "outerIndex", "innerIndex"]
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
// [TRANSFORM] lift: input and output schemas injected
const passthroughLabels = lift((labels: string[]) => labels, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h501ebd2fc822 = __cfHelpers.lift<{
    state: {
        threads: Thread[];
        showFlagged: boolean;
    };
}, { thread: Thread; outerIndex: number; visibleComments: Comment[]; }[]>(({ state }) => 
// [TRANSFORM] .map() stays plain: state.threads is a captured input, plain inside this computed
state.threads.map((thread, outerIndex) => ({
    thread,
    outerIndex,
    visibleComments: state.showFlagged
        ? thread.comments.filter((comment) => comment.flagged)
        : thread.comments,
})), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                threads: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Thread"
                    }
                },
                showFlagged: {
                    type: "boolean"
                }
            },
            required: ["threads", "showFlagged"]
        }
    },
    required: ["state"],
    $defs: {
        Thread: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                muted: {
                    type: "boolean"
                },
                comments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment"
                    }
                }
            },
            required: ["id", "title", "muted", "comments"]
        },
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            thread: {
                $ref: "#/$defs/Thread"
            },
            outerIndex: {
                type: "number"
            },
            visibleComments: {
                type: "array",
                items: {
                    $ref: "#/$defs/Comment"
                }
            }
        },
        required: ["thread", "outerIndex", "visibleComments"]
    },
    $defs: {
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
        },
        Thread: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                muted: {
                    type: "boolean"
                },
                comments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment"
                    }
                }
            },
            required: ["id", "title", "muted", "comments"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_hcca64af3f49f = __cfHelpers.lift<{
    visibleComments: Comment[];
}, Comment[]>(({ visibleComments }) => visibleComments, {
    type: "object",
    properties: {
        visibleComments: {
            type: "array",
            items: {
                $ref: "#/$defs/Comment"
            }
        }
    },
    required: ["visibleComments"],
    $defs: {
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/Comment"
    },
    $defs: {
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h237caf5ae9ed = __cfHelpers.lift<{
    reboundIndex: number;
    outerIndex: number;
}, boolean>(({ reboundIndex, outerIndex }) => reboundIndex === outerIndex, {
    type: "object",
    properties: {
        reboundIndex: {
            type: "number"
        },
        outerIndex: {
            type: "number"
        }
    },
    required: ["reboundIndex", "outerIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h2c81ffb44100 = __cfHelpers.lift<{
    state: {
        lane: string;
    };
    comment: {
        id: string;
    };
}, string>(({ state, comment }) => `${state.lane}:${comment.id}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                lane: {
                    type: "string"
                }
            },
            required: ["lane"]
        },
        comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    },
    required: ["state", "comment"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_h9876d1a32b2f = __cfHelpers.pattern(__cf_pattern_input => {
    const comment = __cf_pattern_input.key("element");
    const reboundIndex = __cf_pattern_input.key("index");
    const outerIndex = __cf_pattern_input.params.outerIndex;
    const state = __cf_pattern_input.key("params", "state");
    return (<aside>
              {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h237caf5ae9ed({
        reboundIndex: reboundIndex,
        outerIndex: outerIndex
    }), __cfLift_h2c81ffb44100({
        state: {
            lane: state.key("lane")
        },
        comment: {
            id: comment.key("id")
        }
    }), comment.key("text"))}
            </aside>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                }
            },
            required: ["id", "text"]
        },
        index: {
            type: "number"
        },
        params: {
            type: "object",
            properties: {
                outerIndex: {
                    type: "number"
                },
                state: {
                    type: "object",
                    properties: {
                        lane: {
                            type: "string"
                        }
                    },
                    required: ["lane"]
                }
            },
            required: ["outerIndex", "state"]
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
const __cfLift_h7a3748fcc627 = __cfHelpers.lift<{
    edgeIndex: number;
    outerIndex: number;
}, boolean>(({ edgeIndex, outerIndex }) => edgeIndex === outerIndex, {
    type: "object",
    properties: {
        edgeIndex: {
            type: "number"
        },
        outerIndex: {
            type: "number"
        }
    },
    required: ["edgeIndex", "outerIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_hce182c9f2358 = __cfHelpers.lift<{
    state: {
        lane: string;
    };
    edge: string;
}, string>(({ state, edge }) => `${state.lane}:${edge}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                lane: {
                    type: "string"
                }
            },
            required: ["lane"]
        },
        edge: {
            type: "string"
        }
    },
    required: ["state", "edge"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_he535898b6b88 = __cfHelpers.pattern(__cf_pattern_input => {
    const edge = __cf_pattern_input.key("element");
    const edgeIndex = __cf_pattern_input.key("index");
    const outerIndex = __cf_pattern_input.params.outerIndex;
    const state = __cf_pattern_input.key("params", "state");
    return (<small>
              {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_h7a3748fcc627({
        edgeIndex: edgeIndex,
        outerIndex: outerIndex
    }), __cfLift_hce182c9f2358({
        state: {
            lane: state.key("lane")
        },
        edge: edge
    }), edge)}
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
                outerIndex: {
                    type: "number"
                },
                state: {
                    type: "object",
                    properties: {
                        lane: {
                            type: "string"
                        }
                    },
                    required: ["lane"]
                }
            },
            required: ["outerIndex", "state"]
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
const __cfLift_h99f835fa1c74 = __cfHelpers.lift<{
    visibleThreads: {
        thread: {
            title: string;
            id: string;
            muted: boolean;
        };
        visibleComments: {
            id: string;
            flagged: boolean;
            text: string;
            reactions: string[];
        }[];
        outerIndex: number;
    }[];
    selectedCommentId: __cfHelpers.ReadonlyCell<string | undefined>;
    state: {
        lane: string;
    };
}, __cfHelpers.JSXElement[]>(({ visibleThreads, selectedCommentId, state }) => 
// [TRANSFORM] .map() stays plain: visibleThreads is a captured input, plain inside this computed
visibleThreads.map(({ thread, outerIndex, visibleComments }) => {
    // [TRANSFORM] .map() stays plain: ["top","bottom"] is a literal array
    const plainSeparators = ["top", "bottom"].map((edge) => `${thread.title}-${edge}`);
    const liftedSeparators = passthroughLabels(plainSeparators).for("liftedSeparators", true);
    // [TRANSFORM] computed() → lift() (nested): captures visibleComments from outer computed scope
    const reboundComments = __cfLift_hcca64af3f49f({ visibleComments: visibleComments }).for("reboundComments", true);
    return (<article>
          <h2>{thread.title}</h2>
          {/* [TRANSFORM] .map() stays plain: visibleComments is destructured from captured computed input */}
          {visibleComments.map((comment, innerIndex) => (<div>
              <button type="button" onClick={jumpToComment({
                selectedCommentId: selectedCommentId,
                threadId: thread.id,
                commentId: comment.id,
                lane: state.lane,
                outerIndex,
                innerIndex,
            })}>
                {comment.flagged
                ? <strong>{comment.text}</strong>
                : /* [TRANSFORM] ifElse: schema-injected authored ifElse(thread.muted, ..., ...) */ ifElse({
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
                } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, thread.muted, <em>{comment.text}</em>, <span>{comment.text}</span>)}
              </button>
              {/* [TRANSFORM] .map() stays plain: comment.reactions is compute-owned nested array data */}
              {comment.reactions.map((reaction, reactionIndex) => (<span>
                  {reactionIndex === innerIndex
                    ? `${state.lane}:${reaction}`
                    : reaction}
                </span>))}
            </div>))}
          {/* [TRANSFORM] .map() → mapWithPattern: reboundComments is output of nested computed() — reactive even inside outer computed */}
          {/* [TRANSFORM] closure captures: outerIndex (via params opaque), state.lane (via params reactive .key()) */}
          {reboundComments.mapWithPattern(__cfPattern_h9876d1a32b2f, {
            outerIndex: outerIndex,
            state: {
                lane: state.lane
            }
        })}
          {/* [TRANSFORM] .map() → mapWithPattern: liftedSeparators is output of lift() — reactive even inside outer computed */}
          {/* [TRANSFORM] closure captures: outerIndex (via params opaque), state.lane (via params reactive .key()) */}
          {liftedSeparators.mapWithPattern(__cfPattern_he535898b6b88, {
            outerIndex: outerIndex,
            state: {
                lane: state.lane
            }
        })}
          {/* [TRANSFORM] .map() stays plain: plainSeparators is a local literal array */}
          {plainSeparators.map((edge) => <small>{edge}</small>)}
        </article>);
}), {
    type: "object",
    properties: {
        visibleThreads: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    thread: {
                        type: "object",
                        properties: {
                            title: {
                                type: "string"
                            },
                            id: {
                                type: "string"
                            },
                            muted: {
                                type: "boolean"
                            }
                        },
                        required: ["title", "id", "muted"]
                    },
                    visibleComments: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string"
                                },
                                flagged: {
                                    type: "boolean"
                                },
                                text: {
                                    type: "string"
                                },
                                reactions: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    }
                                }
                            },
                            required: ["id", "flagged", "text", "reactions"]
                        }
                    },
                    outerIndex: {
                        type: "number"
                    }
                },
                required: ["thread", "visibleComments", "outerIndex"]
            }
        },
        selectedCommentId: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "undefined"
                }],
            asCell: ["readonly"]
        },
        state: {
            type: "object",
            properties: {
                lane: {
                    type: "string"
                }
            },
            required: ["lane"]
        }
    },
    required: ["visibleThreads", "selectedCommentId", "state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        $ref: "#/$defs/JSXElement"
    },
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_hc40d6438fae7 = __cfHelpers.lift<{
    labelIndex: number;
}, boolean>(({ labelIndex }) => labelIndex === 0, {
    type: "object",
    properties: {
        labelIndex: {
            type: "number"
        }
    },
    required: ["labelIndex"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_h4866d7f7ca10 = __cfHelpers.lift<{
    state: {
        lane: string;
    };
    label: string;
}, string>(({ state, label }) => `${state.lane}:${label}`, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                lane: {
                    type: "string"
                }
            },
            required: ["lane"]
        },
        label: {
            type: "string"
        }
    },
    required: ["state", "label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_hc09ff3953e73 = __cfHelpers.pattern(__cf_pattern_input => {
    const label = __cf_pattern_input.key("element");
    const labelIndex = __cf_pattern_input.key("index");
    const state = __cf_pattern_input.key("params", "state");
    return (<header data-lane-label={labelIndex}>
            {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_hc40d6438fae7({ labelIndex: labelIndex }), __cfLift_h4866d7f7ca10({
        state: {
            lane: state.key("lane")
        },
        label: label
    }), label)}
          </header>);
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
                state: {
                    type: "object",
                    properties: {
                        lane: {
                            type: "string"
                        }
                    },
                    required: ["lane"]
                }
            },
            required: ["state"]
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
const __cfPattern_hcb517b892e1a = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    const rowIndex = __cf_pattern_input.key("index");
    return (<section data-row={rowIndex}>{row}</section>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/JSXElement"
        },
        index: {
            type: "number"
        }
    },
    required: ["element"],
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
    const selectedCommentId = new Writable<string | undefined>(undefined, {
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("selectedCommentId", true);
    const laneLabels = passthroughLabels(["lane", "detail", "summary"]).for("laneLabels", true);
    // [TRANSFORM] computed() → lift(): captures state.threads, state.showFlagged
    const visibleThreads = __cfLift_h501ebd2fc822({ state: {
            threads: state.key("threads"),
            showFlagged: state.key("showFlagged")
        } }).for("visibleThreads", true);
    // [TRANSFORM] computed() → lift(): captures visibleThreads (asOpaque), selectedCommentId (asCell — Writable), state.lane
    const threadRows = __cfLift_h99f835fa1c74({
        visibleThreads: visibleThreads,
        selectedCommentId: selectedCommentId,
        state: {
            lane: state.key("lane")
        }
    }).for("threadRows", true);
    return {
        [UI]: (<div>
        {/* [TRANSFORM] .map() → mapWithPattern: laneLabels is output of lift() in pattern context — reactive */}
        {/* [TRANSFORM] ternary lowered: labelIndex===0 ? `${state.lane}:${label}` : label → ifElse(lift(cond), lift(true-branch), label) */}
        {laneLabels.mapWithPattern(__cfPattern_hc09ff3953e73, {
                state: {
                    lane: state.key("lane")
                }
            })}
        {/* [TRANSFORM] .map() → mapWithPattern: threadRows is output of computed() — reactive, back in pattern-owned UI */}
        {threadRows.mapWithPattern(__cfPattern_hcb517b892e1a, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        threads: {
            type: "array",
            items: {
                $ref: "#/$defs/Thread"
            }
        },
        lane: {
            type: "string"
        },
        showFlagged: {
            type: "boolean"
        }
    },
    required: ["threads", "lane", "showFlagged"],
    $defs: {
        Thread: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                title: {
                    type: "string"
                },
                muted: {
                    type: "boolean"
                },
                comments: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Comment"
                    }
                }
            },
            required: ["id", "title", "muted", "comments"]
        },
        Comment: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                text: {
                    type: "string"
                },
                flagged: {
                    type: "boolean"
                },
                reactions: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["id", "text", "flagged", "reactions"]
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
    jumpToComment,
    passthroughLabels,
    __cfLift_h501ebd2fc822,
    __cfLift_hcca64af3f49f,
    __cfLift_h237caf5ae9ed,
    __cfLift_h2c81ffb44100,
    __cfPattern_h9876d1a32b2f,
    __cfLift_h7a3748fcc627,
    __cfLift_hce182c9f2358,
    __cfPattern_he535898b6b88,
    __cfLift_h99f835fa1c74,
    __cfLift_hc40d6438fae7,
    __cfLift_h4866d7f7ca10,
    __cfPattern_hc09ff3953e73,
    __cfPattern_hcb517b892e1a,
    __cfLift_1: __cfLift_h501ebd2fc822,
    __cfLift_2: __cfLift_hcca64af3f49f,
    __cfLift_3: __cfLift_h237caf5ae9ed,
    __cfLift_4: __cfLift_h2c81ffb44100,
    __cfPattern_1: __cfPattern_h9876d1a32b2f,
    __cfLift_5: __cfLift_h7a3748fcc627,
    __cfLift_6: __cfLift_hce182c9f2358,
    __cfPattern_2: __cfPattern_he535898b6b88,
    __cfLift_7: __cfLift_h99f835fa1c74,
    __cfLift_8: __cfLift_hc40d6438fae7,
    __cfLift_9: __cfLift_h4866d7f7ca10,
    __cfPattern_3: __cfPattern_hc09ff3953e73,
    __cfPattern_4: __cfPattern_hcb517b892e1a
});
