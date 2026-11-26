/**
 * Test Pattern: the Common Fabric LLM tools
 *
 * Each export of `common-fabric.tsx` is a tool an assistant calls. The
 * calculator and the list handler are pure, so the test states their answers
 * directly. The rest reach the network, and the test serves their endpoints
 * through `fetchMocks`, so what is asserted is the tool's reading of a known
 * response.
 */
import { action, assert, pattern, TESTS, wish, Writable } from "commonfabric";
import {
  addListItem,
  bash,
  calculator,
  fetchAndRunPattern,
  type ListItem,
  listPatternIndex,
  updateProfile,
} from "./common-fabric.tsx";

const PROGRAM_URL = "https://programs.test/doubler.tsx";

export const fetchMocks = [
  {
    urlIncludes: "/api/sandbox/exec",
    body: '{"stdout":"hello\\n","stderr":"","exitCode":0}',
  },
  {
    urlIncludes: "/custom/patterns.md",
    contentType: "text/markdown",
    body: "# Custom index",
  },
  {
    urlIncludes: PROGRAM_URL,
    contentType: "text/plain",
    body: [
      'import { computed, pattern } from "commonfabric";',
      "export default pattern<{ value: number }, { doubled: number }>(",
      "  ({ value }) => ({ doubled: computed(() => value * 2) }),",
      ");",
    ].join("\n"),
  },
];

export default pattern(() => {
  // Calculator: precedence, parentheses, unary signs, division, other bases.
  const precedence = calculator({ expression: "2 + 3 * (4 - 1)" });
  const unary = calculator({ expression: "-(2 + 3) * +2 / 4" });
  const binary = calculator({ expression: "5", base: 2 });
  const badBase = calculator({ expression: "255", base: 99 });
  // Characters outside the grammar are stripped before parsing.
  const stripped = calculator({ expression: "two 2 + x3" });
  const unclosed = calculator({ expression: "(1 + 2" });
  const noOperand = calculator({ expression: "1 + *" });
  const badNumber = calculator({ expression: "1.2.3" });
  const trailing = calculator({ expression: "1 2" });
  const divideByZero = calculator({ expression: "1 / 0" });

  // addListItem appends and reports the new length through `result`.
  const list = new Writable<ListItem[]>([{ title: "eggs" }]);
  const addResult = new Writable<string>("");
  const add = addListItem({ list });
  const action_add_item = action(() => {
    add.send({ item: "milk", result: addResult });
  });

  // A stored list that some other writer left as a string: the tool reports
  // the failure through `result` rather than leaving the caller waiting.
  const brokenList = new Writable<ListItem[]>(JSON.parse('"not a list"'));
  const brokenResult = new Writable<string>("");
  const addToBroken = addListItem({ list: brokenList });
  const action_add_to_broken_list = action(() => {
    addToBroken.send({ item: "milk", result: brokenResult });
  });

  const shell = bash({
    command: "echo hello",
    workingDirectory: "/tmp",
    timeout: 1000,
    environment: { GREETING: "hello" },
    sandboxId: "sandbox-1",
  });

  // A favorite tagged `#patternIndex` names another index to read. The
  // favorite is in place before anything reads the index: a favorite added
  // after the index was read once is seen by the wish, but nothing demands
  // the index while the favoriting action settles, and the assertion that
  // demands it can read it before the fetch has run for the new address, so it
  // would see the earlier index. `pattern-index-default.test.tsx` reads
  // the index with no favorite.
  const index = listPatternIndex({});
  const defaultApp = wish<
    Writable<{ favorites?: { cell: Writable<unknown>; userTags: string[] }[] }>
  >({ query: "#default" }).result!;
  const indexPointer = new Writable<{ url: string }>({
    url: "/custom/patterns.md",
  });
  const action_favorite_custom_index = action(() => {
    defaultApp.key("favorites").set([{
      cell: indexPointer,
      userTags: ["patternindex"],
    }]);
  });

  const run = fetchAndRunPattern({ url: PROGRAM_URL, args: { value: 21 } });

  const profile = updateProfile({ summary: "Likes tea." });

  return {
    [TESTS]: [
      { action: action_favorite_custom_index },
      { assertion: assert(() => precedence === "11") },
      { assertion: assert(() => unary === "-2.5") },
      { assertion: assert(() => binary === "101") },
      { assertion: assert(() => badBase === "255") },
      { assertion: assert(() => stripped === "5") },
      {
        assertion: assert(() =>
          typeof unclosed === "object" &&
          unclosed.error === "Invalid expression"
        ),
      },
      {
        assertion: assert(() =>
          typeof noOperand === "object" &&
          noOperand.error === "Invalid expression"
        ),
      },
      {
        assertion: assert(() =>
          typeof badNumber === "object" && badNumber.error === "Invalid number"
        ),
      },
      {
        assertion: assert(() =>
          typeof trailing === "object" &&
          trailing.error === "Invalid expression"
        ),
      },
      {
        assertion: assert(() =>
          typeof divideByZero === "object" &&
          divideByZero.error === "Invalid expression"
        ),
      },
      { action: action_add_item },
      { assertion: assert(() => addResult.get() === "2 items") },
      {
        assertion: assert(() =>
          list.get().map((item) => item.title).join(",") === "eggs,milk"
        ),
      },
      { action: action_add_to_broken_list },
      {
        assertion: assert(() =>
          brokenResult.get().startsWith("Error: Cell.push()")
        ),
      },
      { settle: true },
      {
        assertion: assert(() =>
          "stdout" in shell && shell.stdout === "hello\n" &&
          shell.exitCode === 0
        ),
      },
      { assertion: assert(() => index?.result === "# Custom index") },
      {
        assertion: assert(() =>
          run !== undefined && run.error === undefined &&
          run.cell !== undefined
        ),
      },
      { settle: true },
      { assertion: assert(() => run?.cell?.doubled === 42) },
      {
        assertion: assert(() =>
          profile.success === true &&
          profile.message === "Profile updated successfully"
        ),
      },
    ],
  };
});
