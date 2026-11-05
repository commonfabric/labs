#!/usr/bin/env -S deno run --allow-read --allow-env

/**
 * .claude/scripts/pre-edit-reminders.ts
 *
 * Claude Code Pre-Tool hook for Write|Edit.
 * - Names the documentation for the area a file being edited belongs to.
 * - Reaches the model through `additionalContext`, which carries text and
 *   expresses no permission decision, leaving the edit's own prompt to stand.
 */

import { guardProjectDir, parseFilePath } from "./common/guard.ts";
guardProjectDir();

const filePath = await parseFilePath();
// The edited file's path from the project's root, so that a directory named
// `patterns` inside another one, such as a route's, is not taken for the
// top-level one.
const projectRoot = `${Deno.env.get("CLAUDE_PROJECT_DIR") || Deno.cwd()}/`;
const projectPath = filePath.startsWith(projectRoot)
  ? filePath.slice(projectRoot.length)
  : filePath;

const reminders: string[] = [];

// The pattern trees `PATTERN_TREES` in `tasks/pattern-files.ts` lists, which
// are `patterns` and the two connector trees named by
// `CONNECTOR_PATTERN_SOURCES`. A `.tsx` file outside them is a component or a
// test fixture, and the pattern documentation describes neither.
const inPatternTree = [
  "patterns/",
  "connectors/agents/debug-view/",
  "connectors/github/activity-view/",
].some((tree) => projectPath.startsWith(tree));

if (filePath.endsWith(".tsx") && inPatternTree) {
  reminders.push(
    "Patterns: the `pattern-dev` skill is the entry point, " +
      "`docs/common/README.md` indexes the rest, and " +
      "`docs/development/LOCAL_DEV_SERVERS.md` covers running one locally",
  );
}

if (projectPath.startsWith("runtime/ui/")) {
  reminders.push(
    "UI components: the `lit-component` skill covers Lit, the theme system " +
      "and Cell access; `docs/common/components/COMPONENTS.md` lists what " +
      "already exists",
  );
}

if (reminders.length > 0) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: reminders.join(" | "),
    },
  }));
}

Deno.exit(0);
