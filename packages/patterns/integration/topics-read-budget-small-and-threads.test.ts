/**
 * Holds the `small-and-threads` group of Topics read-budget cases (the small
 * pivot cases; the thread cases the name recalls measured lifts that stored
 * values replaced, and the name stays as the test's identity) to the limits
 * in `topics-read-budget-limits.ts`. Each case runs the headless Topics
 * fixture in this process, with no browser and no server.
 */

import { describe } from "@std/testing/bdd";

import { describeReadBudgetGroup } from "./topics-read-budget-suite.ts";

describe("topics-read-budget-small-and-threads", () => {
  describeReadBudgetGroup("small-and-threads", import.meta.url);
});
