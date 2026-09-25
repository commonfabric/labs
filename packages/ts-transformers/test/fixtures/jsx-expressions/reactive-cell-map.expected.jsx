function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, cell, handler, ifElse, lift, NAME, navigateTo, pattern, UI, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// the simple piece (to which we'll store references within a cell)
const SimplePattern = pattern(() => ({
    [NAME]: "Some Simple Pattern",
    [UI]: <div>Some Simple Pattern</div>,
}), false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
// Create a cell to store an array of pieces
const createCellRef = lift(({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
        console.log("Creating cellRef - first time");
        const newCellRef = Cell.for<any[]>("piecesArray").asSchema({
            type: "array",
            items: true
        } as const satisfies __cfHelpers.JSONSchema);
        newCellRef.set([]);
        const storedCellValue: Cell<unknown> = storedCellRef;
        storedCellValue.set(newCellRef);
        isInitialized.set(true);
        return {
            cellRef: newCellRef,
        };
    }
    else {
        console.log("cellRef already initialized");
    }
    // If already initialized, return the stored cellRef
    return {
        cellRef: storedCellRef,
    };
}, {
    type: "object",
    properties: {
        isInitialized: { type: "boolean", "default": false, asCell: ["cell"] },
        storedCellRef: { type: "object", asCell: ["cell"] },
    },
    required: ["isInitialized", "storedCellRef"],
});
// Add a piece to the array and navigate to it
// we get a new isInitialized passed in for each
// piece we add to the list. this makes sure
// we only try to add the piece once to the list
// and we only call navigateTo once
const addPieceAndNavigate = lift(({ piece, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
        if (cellRef) {
            cellRef.push(piece);
            isInitialized.set(true);
            return navigateTo(piece);
        }
        else {
            console.log("addPieceAndNavigate undefined cellRef");
        }
    }
    return undefined;
}, {
    type: "object",
    properties: {
        piece: { type: "object" },
        cellRef: { type: "array", asCell: ["cell"] },
        isInitialized: { type: "boolean", asCell: ["cell"] },
    },
    required: ["piece", "isInitialized"],
});
// Create a new SimplePattern and add it to the array
const createSimplePattern = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: true,
            asCell: ["readonly"]
        }
    },
    required: ["cellRef"]
} as const satisfies __cfHelpers.JSONSchema, (_, { cellRef }) => {
    // Create isInitialized cell for this piece addition
    const isInitialized = cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("isInitialized", true);
    // Create the piece
    const piece = SimplePattern({});
    // Store the piece in the array and navigate
    return addPieceAndNavigate({ piece, cellRef, isInitialized });
});
// Handler to navigate to a specific piece from the list
const goToPiece = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        piece: {
            type: "unknown",
            asCell: ["opaque"]
        }
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, (_, { piece }) => {
    console.log("goToPiece clicked");
    return navigateTo(piece);
});
const __cfLift_h47a985a89abd = __cfHelpers.lift<{
    cellRef: unknown[];
}, boolean>(({ cellRef }) => !cellRef?.length, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["cellRef"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_h91b64b70a4ed = __cfHelpers.lift<{
    piece: any;
}, any>(({ piece }) => piece[__cfHelpers.NAME], {
    type: "object",
    properties: {
        piece: true
    },
    required: ["piece"]
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfPattern_h1a719250c3fa = __cfHelpers.pattern(__cf_pattern_input => {
    const piece = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<li>
                <cf-button onClick={goToPiece({ piece })}>
                  Go to Piece {index + 1}
                </cf-button>
                <span>Piece {index + 1}: {__cfHelpers.unless(true as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, __cfLift_h91b64b70a4ed({ piece: piece }), "Unnamed")}</span>
              </li>);
}, {
    type: "object",
    properties: {
        element: true,
        index: {
            type: "number"
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
// FIXTURE: reactive-cell-map
// Verifies: a reactive factory result still rewrites JSX ifElse predicates after
//           the forbidden Reactive cast is removed
//   ifElse(!cellRef?.length, <div>, <ul>) → ifElse(schema..., lift(...)(...), <div>, <ul>)
//   cellRef.map((piece, index) => <li>...) → mapWithPattern(...) even with
//     `as { cellRef: any[] }`, because the cast does not change the reactive origin
// Context: Real-world pattern using Cell.for<any[]>(), handler, lift, and navigateTo
// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
    // cell to store array of pieces we created
    const __cf_destructure_1 = createCellRef({
        isInitialized: cell(false, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema),
        storedCellRef: cell(),
    }) as {
        cellRef: any[];
    }, cellRef = __cf_destructure_1.key("cellRef").for("cellRef", true);
    return {
        [NAME]: "Pieces Launcher",
        [UI]: (<div>
        <h3>Stored Pieces:</h3>
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfLift_h47a985a89abd({ cellRef: cellRef }), <div>No pieces created yet</div>, <ul>
            {cellRef.mapWithPattern(__cfPattern_h1a719250c3fa, {})}
          </ul>)}

        <cf-button onClick={createSimplePattern({ cellRef })}>
          Create New Piece
        </cf-button>
      </div>),
        cellRef,
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string",
            "enum": ["Pieces Launcher"]
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        cellRef: {
            type: "array",
            items: true
        }
    },
    required: ["$NAME", "$UI", "cellRef"],
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
    SimplePattern,
    createCellRef,
    addPieceAndNavigate,
    createSimplePattern,
    goToPiece,
    __cfLift_h47a985a89abd,
    __cfLift_h91b64b70a4ed,
    __cfPattern_h1a719250c3fa,
    __cfLift_1: __cfLift_h47a985a89abd,
    __cfLift_2: __cfLift_h91b64b70a4ed,
    __cfPattern_1: __cfPattern_h1a719250c3fa
});
