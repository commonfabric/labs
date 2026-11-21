/**
 * Test Pattern: Cheeseboard
 *
 * Answers the web-read request with a canned page and reads the pizza list
 * the view renders from it. The page holds every shape the extractor has to
 * tell apart: a dated pizza spread over several lines, descriptions ended by
 * the next heading, the next date, and a blank line, a date followed by
 * something other than a pizza, a pizza heading with no description, and a
 * date that is not in the schedule's format.
 *
 * Run: deno task cf test patterns/apps/cheeseboard/cheeseboard.test.tsx --verbose
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  countElements,
  findElementByText,
  hasExactText,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import Cheeseboard from "./cheeseboard.tsx";

const PAGE = [
  "# Pizza schedule",
  "Tue Nov 11",
  "",
  "### Pizza",
  "",
  "Roasted potato, onion,",
  "rosemary and garlic",
  "### Salad",
  "Mixed greens",
  "Wed Nov 12",
  "### Salad",
  "Not a pizza",
  "Thu Nov 13",
  "### Pizza",
  "",
  "Fri Nov 14",
  "### Pizza",
  "Corn, tomato and feta",
  "Sat Nov 15",
  "### Pizza",
  "Mushroom and leek",
  "",
  "Ask about our salads",
  "Saturday November 16",
  "### Pizza",
  "Never listed",
].join("\r\n");

export const fetchMocks = [
  {
    urlIncludes: "/api/agent-tools/web-read",
    contentType: "application/json",
    body: JSON.stringify({ content: PAGE, metadata: { word_count: 42 } }),
  },
];

export default pattern(() => {
  const board = Cheeseboard({});

  const assert_names_itself = assert(() => board[NAME] === "Cheeseboard");
  const assert_links_the_schedule = assert(() =>
    hasExactText(
      findElementByText(board[UI], "a", "cheeseboardcollective.coop"),
      "https://cheeseboardcollective.coop/home/pizza/pizza-schedule/",
    )
  );
  const assert_lists_the_pizzas = assert(() =>
    countElements(board[UI], "li") === 3 &&
    hasExactText(
      findElementByText(board[UI], "li", "Tue Nov 11"),
      "Tue Nov 11: Roasted potato, onion, rosemary and garlic",
    ) &&
    hasExactText(
      findElementByText(board[UI], "li", "Fri Nov 14"),
      "Fri Nov 14: Corn, tomato and feta",
    ) &&
    hasExactText(
      findElementByText(board[UI], "li", "Sat Nov 15"),
      "Sat Nov 15: Mushroom and leek",
    ) &&
    !hasText(board[UI], "Ask about our salads") &&
    !hasText(board[UI], "Not a pizza") &&
    !hasText(board[UI], "Never listed")
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_links_the_schedule },
      { settle: true },
      { assertion: assert_lists_the_pizzas },
    ],
    board,
  };
});
