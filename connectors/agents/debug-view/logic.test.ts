import { assertEquals } from "@std/assert";
import {
  commandDraftError,
  type CommandDraftFields,
  commandPayload,
  linkedCellJson,
  materializeRootCell,
  providerSessionRetrieval,
  sessionSortLabel,
  statusColor,
} from "./logic.ts";

const draft: CommandDraftFields = {
  sourceId: "codex",
  nativeSessionId: "session-1",
  type: "prompt",
  promptText: "continue",
  argument: "value",
  configKey: "model",
  configValue: "gpt-test",
  configValueType: "string",
};

Deno.test("command drafts validate every bounded field", () => {
  const cases: Array<[Partial<CommandDraftFields>, string]> = [
    [{ sourceId: " " }, "Choose a source."],
    [{ sourceId: "x".repeat(257) }, "Source IDs are limited"],
    [{ sourceId: "bad\nsource" }, "Source IDs cannot contain control"],
    [{ nativeSessionId: " " }, "Choose or enter a session ID."],
    [{ nativeSessionId: "x".repeat(1_025) }, "Session IDs are limited"],
    [{ nativeSessionId: "bad\tsession" }, "Session IDs cannot contain control"],
    [{ promptText: " " }, "Enter a prompt."],
    [{ promptText: "x".repeat(128 * 1_024 + 1) }, "Prompts are limited"],
    [{ type: "start", promptText: " " }, "Enter a prompt."],
    [{ type: "rename", argument: " " }, "Enter a new title."],
    [{ type: "rename", argument: "x".repeat(513) }, "Titles are limited"],
    [{ type: "set-mode", argument: " " }, "Enter a mode ID."],
    [{ type: "set-mode", argument: "x".repeat(129) }, "Mode IDs are limited"],
    [
      { type: "set-config-option", configKey: " " },
      "Enter a configuration option key.",
    ],
    [
      { type: "set-config-option", configKey: "x".repeat(257) },
      "Configuration option keys are limited",
    ],
  ];
  for (const [overrides, message] of cases) {
    assertEquals(
      commandDraftError({ ...draft, ...overrides }).includes(message),
      true,
    );
  }
  assertEquals(commandDraftError(draft), "");
});

Deno.test("command payloads preserve each command's value type", () => {
  assertEquals(commandPayload(draft), { text: "continue" });
  assertEquals(commandPayload({ ...draft, type: "start" }), {
    text: "continue",
  });
  assertEquals(commandPayload({ ...draft, type: "cancel" }), {});
  assertEquals(
    commandPayload({ ...draft, type: "rename", argument: " new " }),
    {
      title: "new",
    },
  );
  assertEquals(
    commandPayload({ ...draft, type: "set-mode", argument: " plan " }),
    {
      mode: "plan",
    },
  );
  assertEquals(commandPayload({ ...draft, type: "set-config-option" }), {
    key: "model",
    value: "gpt-test",
  });
  assertEquals(
    commandPayload({
      ...draft,
      type: "set-config-option",
      configValueType: "true",
    }),
    { key: "model", value: true },
  );
  assertEquals(
    commandPayload({
      ...draft,
      type: "set-config-option",
      configValueType: "false",
    }),
    { key: "model", value: false },
  );
});

Deno.test("provider retrieval instructions cover every connector driver", () => {
  assertEquals(
    providerSessionRetrieval(null, "codex", "session-1").includes(
      "reads the producing driver",
    ),
    true,
  );
  const cases = [
    ["codex-app-server", '"thread/read"'],
    ["claude-agent-sdk", "getSessionMessages"],
    ["acp", "session/load"],
    ["custom-driver", "listSessions and readSession"],
  ] as const;
  for (const [driver, operation] of cases) {
    const instructions = providerSessionRetrieval(driver, "source", "native");
    assertEquals(instructions.includes(`producing driver "${driver}"`), true);
    assertEquals(instructions.includes(operation), true);
  }
});

Deno.test("status colors and sort labels describe every visible state", () => {
  for (const status of ["ready", "complete", "succeeded", "active"]) {
    assertEquals(statusColor(status), "accent");
  }
  for (
    const status of [
      "starting",
      "syncing",
      "collecting",
      "running",
      "in-flight",
    ]
  ) {
    assertEquals(statusColor(status), "primary");
  }
  for (const status of ["degraded", "partial", "stale", "unknown", "other"]) {
    assertEquals(statusColor(status), "neutral");
  }
  for (const status of ["failed", "deleted"]) {
    assertEquals(statusColor(status), "danger");
  }
  assertEquals(statusColor(undefined), "neutral");
  assertEquals(
    sessionSortLabel("Title", "title", null, "ascending"),
    "Title ↕",
  );
  assertEquals(
    sessionSortLabel("Title", "title", "title", "ascending"),
    "Title ↑",
  );
  assertEquals(
    sessionSortLabel("Title", "title", "title", "descending"),
    "Title ↓",
  );
});

Deno.test("linked cell JSON keeps links explicit without following them", () => {
  const linked = {
    get: () => ({ hidden: true }),
    getAsNormalizedFullLink: () => ({
      id: "entity",
      space: "did:key:space",
      path: ["nested", 1],
      scope: "scope-key",
    }),
  };
  const spaceScoped = {
    get: () => "not followed",
    getAsNormalizedFullLink: () => ({
      id: "other",
      space: "did:key:space",
      path: [],
    }),
  };
  const unresolved = { get: () => "unresolved value" };
  assertEquals(linkedCellJson([linked, { spaceScoped, unresolved }, null]), [
    {
      $cell: {
        id: "entity",
        space: "did:key:space",
        path: ["nested", 1],
        scope: "scope-key",
      },
    },
    {
      spaceScoped: {
        $cell: { id: "other", space: "did:key:space", path: [] },
      },
      unresolved: { $cell: "unresolved" },
    },
    null,
  ]);
  assertEquals(
    materializeRootCell({ get: () => ({ linked, plain: 1 }) }),
    {
      linked: {
        $cell: {
          id: "entity",
          space: "did:key:space",
          path: ["nested", 1],
          scope: "scope-key",
        },
      },
      plain: 1,
    },
  );
  assertEquals(materializeRootCell("plain"), "plain");
});
