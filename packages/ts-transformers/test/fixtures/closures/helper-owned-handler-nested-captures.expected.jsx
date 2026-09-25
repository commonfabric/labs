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
 * TRANSFORM REPRO: helper-owned handler with nested callback captures
 *
 * Compare on main vs transformer branch:
 *   deno task cf check packages/patterns/gideon-tests/test-helper-owned-handler-nested-captures.tsx --show-transformed --no-run
 *
 * Expected main shape:
 * - generated handler state includes `fileId`, `content`, `savedContent`, and
 *   `onSaveFile`
 *
 * Current branch bug:
 * - generated handler state omits captures that the handler body still uses
 *   inside the nested `.then(...)` callback
 */
import { action, Default, pattern, Stream, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
function flushLater(fileId: Writable<Default<string, "">>, content: Writable<Default<string, "">>, savedContent: Writable<Default<string, "">>, onSaveFile: Stream<{
    fileId: string;
    content: string;
}>): void {
    const nextContent = content.get();
    const lastSaved = savedContent.get();
    const targetFileId = fileId.get().trim();
    if (!targetFileId || nextContent === lastSaved)
        return;
    onSaveFile.send({ fileId: targetFileId, content: nextContent });
}
__cfHardenFn(flushLater);
interface Input {
    fileId: Writable<Default<string, "">>;
    content: Writable<Default<string, "">>;
    savedContent: Writable<Default<string, "">>;
    onSaveFile: Stream<{
        fileId: string;
        content: string;
    }>;
}
interface Output {
    trigger: Stream<void>;
}
const __cfHandler_heb6a7002a08c = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        fileId: {
            type: "string",
            "default": "",
            asCell: ["readonly"]
        },
        content: {
            type: "string",
            "default": "",
            asCell: ["readonly"]
        },
        savedContent: {
            type: "string",
            "default": "",
            asCell: ["readonly"]
        },
        onSaveFile: {
            type: "object",
            properties: {
                fileId: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["fileId", "content"],
            asCell: ["stream"]
        }
    },
    required: ["fileId", "content", "savedContent", "onSaveFile"]
} as const satisfies __cfHelpers.JSONSchema, (_, { fileId, content, savedContent, onSaveFile }) => {
    Promise.resolve().then(() => {
        flushLater(fileId, content, savedContent, onSaveFile);
    });
});
export default pattern((__cf_pattern_input) => {
    const fileId = __cf_pattern_input.key("fileId");
    const content = __cf_pattern_input.key("content");
    const savedContent = __cf_pattern_input.key("savedContent");
    const onSaveFile = __cf_pattern_input.key("onSaveFile");
    const trigger = __cfHandler_heb6a7002a08c({
        fileId: fileId,
        content: content,
        savedContent: savedContent,
        onSaveFile: onSaveFile
    }).for({ stream: "trigger" }, true);
    return { trigger: trigger.for({ stream: ["__patternResult", "trigger"] }, true) };
}, {
    type: "object",
    properties: {
        fileId: {
            type: "string",
            "default": "",
            asCell: ["cell"]
        },
        content: {
            type: "string",
            "default": "",
            asCell: ["cell"]
        },
        savedContent: {
            type: "string",
            "default": "",
            asCell: ["cell"]
        },
        onSaveFile: {
            type: "object",
            properties: {
                fileId: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["fileId", "content"],
            asCell: ["stream"]
        }
    },
    required: ["fileId", "content", "savedContent", "onSaveFile"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        trigger: {
            asCell: ["stream", "opaque"]
        }
    },
    required: ["trigger"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_heb6a7002a08c,
    __cfHandler_1: __cfHandler_heb6a7002a08c
});
