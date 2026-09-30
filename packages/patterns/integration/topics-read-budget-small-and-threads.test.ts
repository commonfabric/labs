/**
 * Holds the `small-and-threads` group of Topics read-budget cases to the limits
 * in `topics-read-budget-limits.ts`. Each case runs the headless Topics
 * fixture in this process, with no browser and no server.
 */

import { describe } from "@std/testing/bdd";

import { describeReadBudgetGroup } from "./topics-read-budget-suite.ts";

describe("topics-read-budget-small-and-threads", () => {
  describeReadBudgetGroup("small-and-threads", import.meta.url);
});
