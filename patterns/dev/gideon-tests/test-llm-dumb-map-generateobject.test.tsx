/**
 * Test: `generateObject` called inside `.map()` sends one request per item,
 * and adding or removing an item sends no request for the others.
 *
 * Each mock answers one request and is then used up, so an item whose request
 * were sent again would find no mock left and show an error instead of its
 * sentiment. The item with no mock at all shows that error, and the item with
 * no content sends no request, so it shows neither.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-llm-dumb-map-generateobject.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickInRow,
  findElement,
  findElementByText,
  fireEvent,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import DumbMap from "./test-llm-dumb-map-generateobject.tsx";

export const llmMocks = [
  {
    promptIncludes: "I love this!",
    object: { sentiment: "positive", confidence: 0.9, keywords: ["love"] },
  },
  {
    promptIncludes: "This is terrible",
    object: { sentiment: "negative", confidence: 0.8, keywords: ["terrible"] },
  },
  {
    promptIncludes: "It's okay",
    object: { sentiment: "neutral", confidence: 0.6, keywords: ["okay"] },
  },
];

export default pattern(() => {
  const subject = DumbMap({ items: [{ id: "empty", content: "" }] });

  const action_add_first_two = action(() => {
    const input = findElement(subject[UI], "cf-message-input");
    fireEvent(input, "oncf-send", { detail: { message: " I love this! " } });
    fireEvent(input, "oncf-send", { detail: { message: "This is terrible" } });
  });
  const action_add_third = action(() =>
    fireEvent(findElement(subject[UI], "cf-message-input"), "oncf-send", {
      detail: { message: "It's okay" },
    })
  );
  const action_add_blank = action(() =>
    fireEvent(findElement(subject[UI], "cf-message-input"), "oncf-send", {
      detail: { message: "   " },
    })
  );
  const action_add_unanswered = action(() =>
    fireEvent(findElement(subject[UI], "cf-message-input"), "oncf-send", {
      detail: { message: "Nobody answers this" },
    })
  );
  const action_remove_terrible = action(() =>
    clickInRow(subject[UI], "This is terrible", "Remove")
  );

  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          subject[NAME] === "Test: Dumb Map with generateObject"
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "0/1 completed, 0 pending")
        ),
      },

      { action: action_add_first_two },
      { settle: true },
      {
        assertion: assert(() =>
          [...subject.items].map((item) => item.content).join("|") ===
            "|I love this!|This is terrible"
        ),
      },
      {
        assertion: assert(() =>
          subject.sentimentAnalyses[1]?.analysis.result?.sentiment ===
            "positive"
        ),
      },
      {
        assertion: assert(() =>
          subject.sentimentAnalyses[2]?.analysis.result?.sentiment ===
            "negative"
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "2/3 completed, 0 pending")
        ),
      },
      {
        assertion: assert(() =>
          textContent(findElementByText(subject[UI], "div", "Keywords: love"))
            .includes("POSITIVE (90% confidence)")
        ),
      },
      {
        assertion: assert(() =>
          textContent(
            findElementByText(subject[UI], "div", "Keywords: terrible"),
          ).includes("NEGATIVE (80% confidence)")
        ),
      },

      // A blank message adds no item.
      { action: action_add_blank },
      { assertion: assert(() => subject.items.length === 3) },

      { action: action_add_third },
      { settle: true },
      {
        assertion: assert(() =>
          hasText(subject[UI], "3/4 completed, 0 pending")
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "NEUTRAL (60% confidence)")
        ),
      },
      { assertion: assert(() => !hasText(subject[UI], "Error:")) },

      { action: action_add_unanswered },
      { settle: true },
      {
        assertion: assert(() =>
          hasText(subject[UI], "3/5 completed, 0 pending")
        ),
      },
      {
        assertion: assert(() =>
          subject.sentimentAnalyses[4]?.analysis.error !== undefined &&
          subject.sentimentAnalyses[1]?.analysis.error === undefined
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "Error: Mock mode enabled")
        ),
      },

      { action: action_remove_terrible },
      { settle: true },
      {
        assertion: assert(() =>
          [...subject.items].map((item) => item.content).join("|") ===
            "|I love this!|It's okay|Nobody answers this"
        ),
      },
      { assertion: assert(() => !hasText(subject[UI], "This is terrible")) },
      {
        assertion: assert(() =>
          hasText(subject[UI], "2/4 completed, 0 pending")
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "POSITIVE (90% confidence)") &&
          hasText(subject[UI], "NEUTRAL (60% confidence)")
        ),
      },
      {
        assertion: assert(() =>
          subject.sentimentAnalyses[0]?.content === "" &&
          subject.sentimentAnalyses[0]?.analysis.result === undefined &&
          subject.sentimentAnalyses[0]?.analysis.error === undefined
        ),
      },
    ],
    subject,
    // The builtin warns as it traces each request and reports the failed one.
    allowConsoleWarnings: true,
  };
});
