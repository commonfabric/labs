import { assert, assertEquals } from "@std/assert";
import {
  type BuiltinToolId,
  DEFAULT_PARENT_TOOL_IDS,
} from "../src/contracts/tool-descriptor.ts";
import {
  BUILTIN_TOOL_REGISTRY,
  BUILTIN_TOOLS,
  getBuiltinTool,
} from "../src/tools/registry.ts";
import { WRITE_FILE_MODES } from "../src/tools/write-file.ts";

Deno.test("builtin tool registry includes the agreed first-pass tool floor", () => {
  assertEquals(BUILTIN_TOOLS.map((tool) => tool.descriptor.toolId), [
    "bash",
    "browser",
    "read_file",
    "view_image",
    "web_fetch",
    "read_skill_resource",
    "run_skill_script",
    "edit_file",
    "write_file",
    "delegate_task",
    "run_pattern",
    "read_piece_source",
    "revise_piece",
    "assign_slug",
    "describe_handle",
    "finish_task",
    "search_patterns",
    "record_feedback",
    "search_skills",
    "acquire_skill",
    "research",
    "loom_compose",
    "loom_inspect",
    "loom_authoring_context",
    "loom_search",
    "loom_page_discover",
    "loom_page_inspect",
    "loom_page_read",
    "loom_people",
    "loom_calendar_list",
    "loom_context",
    "loom_profile",
    "submit_result",
  ]);
  assertEquals(BUILTIN_TOOL_REGISTRY.size, 33);
  assertEquals(
    [...DEFAULT_PARENT_TOOL_IDS],
    [
      "bash",
      "read_file",
      "view_image",
      "read_skill_resource",
      "edit_file",
      "write_file",
      "delegate_task",
      "describe_handle",
      "finish_task",
    ] satisfies BuiltinToolId[],
  );
});

Deno.test("edit_file descriptor exposes exact replacement edits", () => {
  const editFileTool = getBuiltinTool("edit_file");
  assert(editFileTool);
  assertEquals(editFileTool.descriptor.effectClass, "write");
  assertEquals(
    (editFileTool.descriptor.inputSchema as {
      properties: {
        edits: {
          items: {
            required: string[];
            properties: { expectedReplacements: { minimum: number } };
          };
        };
      };
    }).properties.edits.items.required,
    ["oldText", "newText"],
  );
  assertEquals(
    (editFileTool.descriptor.inputSchema as {
      properties: {
        edits: {
          items: {
            required: string[];
            properties: { expectedReplacements: { minimum: number } };
          };
        };
      };
    }).properties.edits.items.properties.expectedReplacements.minimum,
    1,
  );
});

Deno.test("builtin tool registry exposes invoke functions for all built-ins", () => {
  for (const tool of BUILTIN_TOOLS) {
    assertEquals(typeof tool.invoke, "function");
  }
});

Deno.test("write_file descriptor includes append support", () => {
  const writeFileTool = getBuiltinTool("write_file");
  assert(writeFileTool);
  assertEquals(WRITE_FILE_MODES, ["replace", "append"]);
  assertEquals(writeFileTool.descriptor.effectClass, "write");
  assertEquals(
    (writeFileTool.descriptor.inputSchema as {
      properties: { mode: { enum: string[] } };
    }).properties.mode.enum,
    ["replace", "append"],
  );
});
