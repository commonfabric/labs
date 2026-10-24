import type {
  HarnessTaskDomain,
  HarnessTaskTag,
  TaskClassificationContext,
} from "../src/task-classification.ts";

/**
 * One ask, what the job held when it was typed, the tags it called for, and
 * the domains its work happens in.
 */
export interface TaskClassificationCase {
  task: string;
  context: TaskClassificationContext;
  expected: HarnessTaskTag[];
  domains: HarnessTaskDomain[];
}

const cell = (name: string) => ({
  name,
  token: `cfh:a:${name.toLowerCase().replaceAll(" ", "-")}`,
  ref: `of:fid1:${name.length}`,
});

/**
 * The asks of the 2026-10-13 playtest, as typed on its sheet, labelled by the
 * kinds of work each one's job did or should have done.
 */
const pomodoroPanel = { inputCells: [cell("Pomodoro Timer")] };
export const PLAYTEST_2026_10_13_TASKS: readonly TaskClassificationCase[] = [
  {
    task: "take me to the lunch poll loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
    domains: [],
  },
  {
    task: "take me to the gardening project loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
    domains: [],
  },
  {
    task: "take me to the quarterly budget loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
    domains: [],
  },
  {
    task: "take me to the lunh pol loom",
    context: pomodoroPanel,
    expected: ["act", "find"],
    domains: [],
  },
  {
    task: "open the loom for this meeting",
    context: { inputCells: [cell("Team Sync")] },
    expected: ["act", "find", "pieces"],
    domains: ["fabric", "personal"],
  },
  {
    task: "when am I next meeting Alex?",
    context: pomodoroPanel,
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "what's on Thursday?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "who haven't I replied to?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "find that email from Anthropic",
    context: pomodoroPanel,
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "what's on Saturday?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "summarise everything in my inbox this week",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "take me to the dinner ideas loom",
    context: {},
    expected: ["act", "find"],
    domains: [],
  },
  {
    task: "when is my next team sync?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "list the available options from the lunch poll",
    context: { inputCells: [cell("Team Lunch Poll")] },
    expected: ["pieces"],
    domains: ["fabric"],
  },
  {
    task: "what is this loom about?",
    context: { inputCells: [cell("FabriChat")] },
    expected: ["find"],
    domains: ["fabric"],
  },
  {
    task: "find a packing-list pattern and add it to this loom",
    context: {},
    expected: ["act", "find"],
    domains: ["fabric"],
  },
  {
    task: "make me a pomodoro timer",
    context: {},
    expected: ["author"],
    domains: ["fabric"],
  },
  {
    task: "add socks to my packing list",
    context: { inputCells: [cell("Packing List")] },
    expected: ["pieces"],
    domains: ["fabric"],
  },
  {
    task: "make me a word guessing game pattern",
    context: pomodoroPanel,
    expected: ["author"],
    domains: ["fabric"],
  },
  {
    task: "find and deploy pomodoro timer pattern",
    context: {},
    expected: ["act", "find"],
    domains: ["fabric"],
  },
  {
    task: "set it to 10 minutes",
    context: pomodoroPanel,
    expected: ["pieces"],
    domains: ["fabric"],
  },
];

/**
 * Asks that reach past the pieces a job holds: the person's own data, the
 * public web, Common Fabric itself, and general knowledge, which is in no
 * domain. The shape eval runs the same asks live.
 */
export const DOMAIN_TASKS: readonly TaskClassificationCase[] = [
  { task: "thanks!", context: {}, expected: ["respond"], domains: [] },
  {
    task: "What is the capital of Australia?",
    context: {},
    expected: ["find"],
    domains: [],
  },
  {
    task: "What's on my calendar tomorrow?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task:
      "Has anyone emailed me about a dentist appointment in the last month?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "What is the latest stable release of Deno?",
    context: {},
    expected: ["find"],
    domains: ["web"],
  },
  {
    task:
      "Research the trade-offs between a heat pump and a gas boiler for a small two-bedroom house, and recommend one.",
    context: {},
    expected: ["find"],
    domains: ["web"],
  },
  {
    task:
      "How does a Common Fabric pattern react when a cell it reads changes?",
    context: {},
    expected: ["find"],
    domains: ["fabric"],
  },
  {
    task: "Help me plan my week.",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "find me a knitting pattern for a scarf",
    context: {},
    expected: ["find"],
    domains: [],
  },
  {
    task: "weather in Brisbane",
    context: {},
    expected: ["find"],
    domains: ["web"],
  },
  {
    task: "buy the cheapest oat milk",
    context: { browserHost: true },
    expected: ["act"],
    domains: ["web"],
  },
];
