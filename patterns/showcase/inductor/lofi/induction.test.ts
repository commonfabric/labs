import { expect } from "@std/expect";

import {
  adoptedAfter,
  buildHifiPrompt,
  buildRewritePrompt,
  gradeItems,
  heldOutExamples,
  HIFI_SCHEMA,
  type HifiState,
  type HistoryEntry,
  type Item,
  type ItemRow,
  judgeProposal,
  labellingCount,
  labelWith,
  looksPersonal,
  markdownOf,
  MAX_RULES,
  MAX_TESTED_LENGTH,
  MIN_F1_GAIN,
  MIN_HELD_OUT,
  newSurprises,
  poolOffer,
  PROPOSAL_SCHEMA,
  REWRITE_SYSTEM,
  rewriteRequest,
  rewriteStatus,
  sameGoal,
  scoreRules,
  settle,
  shareable,
  splitOf,
  summarize,
  verdictsOf,
} from "./induction.ts";
import { type CanonicalRule, checkRule } from "../shared/rule-grammar.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A rule in canonical form, failing the test when it is refused. */
function rule(field: string, pattern: string, predicts = true): CanonicalRule {
  const check = checkRule({ field, pattern, predicts });
  if (!check.ok) throw new Error(check.reason);
  return check.rule;
}

const item = (id: string, subject: string): Item => ({
  id,
  fields: { subject },
});

const answered = (id: string, label: boolean): HifiState => ({
  id,
  answer: { pending: false, result: { label, reasoning: "because" } },
});

// With 30% held out, mail-6, mail-7, mail-12, and mail-13 are held out and
// mail-1 to mail-5, mail-8, and mail-9 train; a test below pins this.
const HELD_OUT = ["mail-6", "mail-7", "mail-12", "mail-13"];
const TRAIN = ["mail-1", "mail-2", "mail-3", "mail-4", "mail-5", "mail-8"];

describe("splitOf", () => {
  it("is stable and puts about the asked share on each side", () => {
    for (const id of HELD_OUT) expect(splitOf(id, 30)).toBe("heldout");
    for (const id of TRAIN) expect(splitOf(id, 30)).toBe("train");
    const ids = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
    const heldOut = ids.filter((id) => splitOf(id, 30) === "heldout").length;
    expect(heldOut).toBeGreaterThan(250);
    expect(heldOut).toBeLessThan(350);
    expect(ids.every((id) => splitOf(id, 0) === "train")).toBe(true);
  });
});

describe("labelWith", () => {
  const rules = [
    rule("subject", "invoice|bill"),
    rule("subject", "spam", false),
  ];

  it("says YES when a YES rule matches and no NO rule does", () => {
    expect(labelWith(rules, { subject: "Your INVOICE" })).toBe(true);
    expect(labelWith(rules, { subject: "spam invoice" })).toBe(false);
    expect(labelWith(rules, { subject: "hello" })).toBe(false);
    expect(labelWith(rules, { body: "invoice" })).toBe(false);
    expect(labelWith([], { subject: "invoice" })).toBe(false);
  });

  it("tests only a field's first MAX_TESTED_LENGTH code units", () => {
    const padding = "x".repeat(MAX_TESTED_LENGTH - "invoice".length);
    expect(labelWith(rules, { subject: `${padding}invoice` })).toBe(true);
    expect(labelWith(rules, { subject: `${padding}xinvoice` })).toBe(false);
  });

  it("skips a seeded rule that is outside the grammar or unsafe", () => {
    const seeded: CanonicalRule[] = [
      { field: "subject", pattern: "(a)\\1", predicts: true, key: "x" },
      { field: "subject", pattern: "(a+)+", predicts: true, key: "y" },
    ];
    expect(labelWith(seeded, { subject: "aa" })).toBe(false);
  });
});

describe("gradeItems", () => {
  const items = [
    item("mail-1", "invoice"),
    item("mail-2", "hello"),
    item("mail-3", "bill"),
    item("mail-4", "pending"),
  ];
  const hifi: HifiState[] = [
    answered("mail-1", true),
    answered("mail-2", false),
    answered("mail-3", true),
    { id: "mail-4", answer: { pending: true } },
  ];

  it("marks a surprise only where a hi-fi label disagrees", () => {
    const rows = gradeItems(items, hifi, [rule("subject", "invoice")], 30);
    expect(rows.map((row) => [row.id, row.hifi, row.lofi, row.surprise]))
      .toEqual([
        ["mail-1", true, true, false],
        ["mail-2", false, false, false],
        ["mail-3", true, false, true],
        ["mail-4", null, false, false],
      ]);
  });

  it("ignores a failed or malformed hi-fi answer", () => {
    const rows = gradeItems(
      items.slice(0, 2),
      [
        { id: "mail-1", answer: { pending: false, error: "down" } },
        { id: "mail-2", answer: { pending: false, result: { label: "yes" } } },
      ],
      [],
      30,
    );
    expect(rows.map((row) => row.hifi)).toEqual([null, null]);
    expect(rows.some((row) => row.surprise)).toBe(false);
  });

  it("counts an answer only for the prompt the item is asked now", () => {
    const call = (asked: string) => ({
      pending: false,
      result: { label: true, reasoning: "because" },
      messages: [
        { role: "user", content: asked },
        { role: "assistant", content: '{"label": true}' },
      ],
    });
    const rows = gradeItems(
      items.slice(0, 2),
      [
        { id: "mail-1", asked: "new goal", answer: call("new goal") },
        // The goal changed, and the call still holds the old answer.
        { id: "mail-2", asked: "new goal", answer: call("old goal") },
      ],
      [],
      30,
    );
    expect(rows.map((row) => row.hifi)).toEqual([true, null]);
  });

  it("summarizes agreement over labelled items", () => {
    const rows = gradeItems(items, hifi, [rule("subject", "invoice")], 30);
    expect(summarize(rows)).toEqual({
      items: 4,
      labelled: 3,
      agreements: 2,
      surprises: 1,
      agreementRate: 2 / 3,
      heldOut: 0,
    });
    expect(summarize([]).agreementRate).toBe(null);
  });
});

/** Rows as grading would give them, from `[id, subject, hifi]`. */
function rows(
  entries: Array<[string, string, boolean]>,
  rules: CanonicalRule[] = [],
): ItemRow[] {
  return gradeItems(
    entries.map(([id, subject]) => item(id, subject)),
    entries.map(([id, , label]) => answered(id, label)),
    rules,
    30,
  );
}

/** Held-out examples where only "invoice" and "bill" subjects are YES. */
const HELD_OUT_ROWS = rows([
  ["mail-6", "Invoice 42", true],
  ["mail-7", "Your bill is ready", true],
  ["mail-12", "Lunch?", false],
  ["mail-13", "Billing team offsite", false],
  ["mail-17", "Team lunch Friday", false],
]);

describe("scoreRules", () => {
  it("scores F1 over YES", () => {
    const examples = heldOutExamples(HELD_OUT_ROWS);
    expect(examples.length).toBe(5);
    expect(scoreRules([rule("subject", "invoice|\\bbill\\b")], examples).f1)
      .toBe(1);
    expect(scoreRules([rule("subject", "invoice")], examples).f1).toBeCloseTo(
      2 / 3,
    );
    expect(scoreRules([rule("subject", "bill")], examples).recall).toBe(0.5);
    expect(scoreRules([], examples).f1).toBe(0);
  });
});

describe("judgeProposal", () => {
  const heldOut = heldOutExamples(HELD_OUT_ROWS);
  const current = [rule("subject", "invoice")];
  const proposal = (...rules: unknown[]) => ({ rules, reasoning: "r" });

  it("accepts a valid set that scores strictly better", () => {
    const judgement = judgeProposal(
      current,
      proposal(
        { field: "subject", pattern: "Invoice|\\bBILL\\b", predicts: true },
      ),
      heldOut,
    );
    expect(judgement.accepted).toBe(true);
    expect(judgement.proposedF1).toBe(1);
    expect(judgement.rules.map((r) => r.pattern)).toEqual([
      "\\bbill\\b|invoice",
    ]);
  });

  it("keeps the current set on a tie", () => {
    const judgement = judgeProposal(
      current,
      proposal({ field: "subject", pattern: "INVOICE", predicts: true }),
      heldOut,
    );
    expect(judgement.accepted).toBe(false);
    expect(judgement.reason).toMatch(/not at least 2 points better/);
  });

  it("needs a margin over the current F1", () => {
    // Eleven held-out examples, ten of them YES: one more caught is a gain
    // of under two points, which is not enough.
    const examples = [
      ...Array.from({ length: 10 }, (_, i) => ({
        fields: { subject: i === 0 ? "receipt" : `invoice ${i}` },
        label: true,
      })),
      { fields: { subject: "lunch" }, label: false },
    ];
    const almost = judgeProposal(
      [rule("subject", "invoice")],
      proposal({
        field: "subject",
        pattern: "invoice|receipt",
        predicts: true,
      }),
      [...examples, ...Array.from({ length: 40 }, () => examples[1])],
    );
    expect(almost.proposedF1).toBeGreaterThan(almost.currentF1);
    expect(almost.proposedF1 - almost.currentF1).toBeLessThan(MIN_F1_GAIN);
    expect(almost.accepted).toBe(false);
  });

  it("scores nothing on fewer than MIN_HELD_OUT examples", () => {
    const judgement = judgeProposal(
      current,
      proposal({
        field: "subject",
        pattern: "invoice|\\bbill\\b",
        predicts: true,
      }),
      heldOut.slice(0, MIN_HELD_OUT - 1),
    );
    expect(judgement.accepted).toBe(false);
    expect(judgement.reason).toMatch(/a proposal needs 5/);
  });

  it("rejects a set that scores worse", () => {
    const judgement = judgeProposal(
      current,
      proposal({ field: "subject", pattern: "bill", predicts: true }),
      heldOut,
    );
    expect(judgement.accepted).toBe(false);
    expect(judgement.proposedF1).toBeLessThan(judgement.currentF1);
  });

  it("rejects the whole set when one rule is out of grammar or unsafe", () => {
    const outOfGrammar = judgeProposal(
      current,
      proposal(
        { field: "subject", pattern: "invoice|\\bbill\\b", predicts: true },
        { field: "subject", pattern: "(?<=re: )bill", predicts: true },
      ),
      heldOut,
    );
    expect(outOfGrammar.accepted).toBe(false);
    expect(outOfGrammar.refusals).toEqual([
      "rule 2: lookaround is not allowed",
    ]);

    const unsafe = judgeProposal(
      current,
      proposal(
        { field: "subject", pattern: "invoice|\\bbill\\b", predicts: true },
        { field: "subject", pattern: "(bill|bills)+", predicts: true },
      ),
      heldOut,
    );
    expect(unsafe.accepted).toBe(false);
    expect(unsafe.refusals[0]).toMatch(/backtrack/);
  });

  it("rejects a set whose rules together could backtrack too long", () => {
    // Each rule is within the per-pattern budget; five of them are not
    // within the set's
    const costly = Array.from({ length: 5 }, (_, i) => ({
      field: "subject",
      pattern: `\\s{0,88}\\s{0,88}${String.fromCharCode(97 + i)}`,
      predicts: true,
    }));
    const judged = judgeProposal(current, { rules: costly }, heldOut);
    expect(judged.accepted).toBe(false);
    expect(judged.refusals).toEqual([
      expect.stringMatching(/rule set could backtrack too long/),
    ]);
    const fewer = judgeProposal(
      current,
      { rules: costly.slice(0, 4) },
      heldOut,
    );
    expect(fewer.refusals).toEqual([]);
  });

  it("rejects malformed and oversized proposals", () => {
    expect(judgeProposal(current, null, heldOut).accepted).toBe(false);
    expect(judgeProposal(current, { rules: "x" }, heldOut).accepted).toBe(
      false,
    );
    const many = Array.from(
      { length: MAX_RULES + 1 },
      (_, i) => ({ field: "subject", pattern: `w${i}`, predicts: true }),
    );
    expect(judgeProposal(current, { rules: many }, heldOut).reason).toMatch(
      /more than/,
    );
  });

  it("accepts nothing without held-out examples", () => {
    const judgement = judgeProposal(
      [],
      proposal({ field: "subject", pattern: "invoice", predicts: true }),
      [],
    );
    expect(judgement.accepted).toBe(false);
    expect(judgement.reason).toMatch(/0 held-out examples/);
  });

  it("collapses rules that are the same in canonical form", () => {
    const judgement = judgeProposal(
      [],
      proposal(
        { field: "subject", pattern: "invoice", predicts: true },
        { field: "subject", pattern: "(INVOICE)", predicts: true },
      ),
      heldOut,
    );
    expect(judgement.rules.length).toBe(1);
  });
});

describe("rewrite gating", () => {
  const training = rows([
    ["mail-1", "invoice", true],
    ["mail-2", "bill due", true],
    ["mail-3", "statement", true],
    ["mail-4", "hi", false],
  ]);

  it("asks only once enough surprises are new", () => {
    expect(newSurprises(training, [])).toEqual(["mail-1", "mail-2", "mail-3"]);
    expect(buildRewritePrompt("Is it a bill?", [], training, [], 4)).toBe("");
    const prompt = buildRewritePrompt("Is it a bill?", [], training, [], 3);
    expect(prompt).toContain("Question: Is it a bill?");
    expect(prompt).toContain('{"subject":"bill due"} → YES');
    // mail-4 arrived after the third surprise, so this request leaves it out
    expect(prompt).not.toContain('{"subject":"hi"}');
    const withAgreement = rows([["mail-4", "hi", false], ...[
      ["mail-1", "invoice", true],
    ] as Array<[string, string, boolean]>]);
    expect(buildRewritePrompt("Is it a bill?", [], withAgreement, [], 1))
      .toContain('{"subject":"hi"} → NO');
    expect(buildRewritePrompt("  ", [], training, [], 1)).toBe("");
  });

  it("never shows the model a held-out example", () => {
    const prompt = buildRewritePrompt(
      "Is it a bill?",
      [],
      [...training, ...HELD_OUT_ROWS],
      [],
      1,
    );
    expect(prompt).not.toContain("Invoice 42");
  });

  it("counts surprises a judged round answered as old", () => {
    const history: HistoryEntry[] = [{
      round: 1,
      accepted: false,
      reason: "r",
      proposed: [],
      refusals: [],
      currentF1: 0,
      proposedF1: 0,
      heldOut: 0,
      answered: ["mail-1", "mail-2"],
      decidedAt: 0,
    }];
    expect(newSurprises(training, history)).toEqual(["mail-3"]);
    expect(buildRewritePrompt("Is it a bill?", [], training, history, 3)).toBe(
      "",
    );
  });

  it("freezes the request on the surprise that crossed the threshold", () => {
    const request = rewriteRequest("Is it a bill?", [], training, [], 2);
    expect(request?.answered).toEqual(["mail-1", "mail-2"]);
    // A later surprise, and a later agreement, change nothing it asks
    const more = [
      ...training,
      ...rows([["mail-5", "bill", true], ["mail-8", "hello", false]]),
    ];
    expect(rewriteRequest("Is it a bill?", [], more, [], 2)).toEqual(request);
    expect(request?.prompt).not.toContain("statement");
    // It waits while an item before the threshold is unlabelled
    const unlabelled = gradeItems(
      [item("mail-9", "bill"), item("mail-1", "invoice"), item("mail-2", "x")],
      [
        { id: "mail-9", answer: { pending: true } },
        answered("mail-1", true),
        answered("mail-2", true),
      ],
      [],
      30,
    );
    expect(rewriteRequest("Is it a bill?", [], unlabelled, [], 2)).toBeNull();
    // A retry asks again, with a different prompt
    const retry = rewriteRequest("Is it a bill?", [], training, [], 2, 1);
    expect(retry?.answered).toEqual(request?.answered);
    expect(retry?.prompt).not.toBe(request?.prompt);
  });

  it("reports where the rewrite stands", () => {
    const request = { prompt: "p", answered: ["mail-1"] };
    const status = (
      request: { prompt: string; answered: string[] } | null,
      generation: { pending: boolean; error?: unknown; result?: unknown },
      rewriteAfter = 2,
      labelling = 0,
    ) =>
      rewriteStatus(
        request,
        generation,
        [],
        training,
        [],
        rewriteAfter,
        labelling,
      );
    // Idle, it counts the new surprises it still waits for, and 0 once it
    // waits only for labels
    const surprises = newSurprises(training, []).length;
    expect(status(null, { pending: false }, surprises + 3)).toEqual({
      status: "idle",
      missing: 3,
    });
    expect(status(null, { pending: false }, surprises)).toEqual({
      status: "idle",
      missing: 0,
    });
    expect(status(request, { pending: true }).status).toBe("pending");
    expect(status(request, { pending: false }).status).toBe("pending");
    // A failed call is not a judgement: nothing to record, nothing answered
    expect(status(request, { pending: false, error: "down" })).toEqual({
      status: "failed",
      reason: "the model call failed: down",
    });
    const ready = status(request, { pending: false, result: { rules: [] } });
    expect(ready.status === "ready" && ready.answered).toEqual(["mail-1"]);
    // Answered, it still waits while any hi-fi call is in flight: a later
    // label can change the held-out score, and recording then can lose it
    expect(
      status(request, { pending: false, result: { rules: [] } }, 2, 1),
    ).toEqual({ status: "pending", labelling: 1 });
    // Idle stays idle: there is nothing to settle
    expect(status(null, { pending: false }, 2, 1).status).toBe("idle");
  });

  it("counts the hi-fi calls still in flight", () => {
    expect(labellingCount([])).toBe(0);
    expect(labellingCount([
      { id: "mail-1", answer: { pending: true } },
      answered("mail-2", true),
      { id: "mail-3", answer: { pending: false, error: "down" } },
      { id: "mail-4", answer: { pending: true } },
    ])).toBe(2);
  });
});

describe("poolOffer", () => {
  const heldOut = heldOutExamples(HELD_OUT_ROWS);
  const current = [rule("subject", "invoice")];
  const better = {
    field: "subject",
    pattern: "invoice|\\bbill\\b",
    predicts: true,
  };

  it("judges the pool's rules on the held-out items, as a rewrite", () => {
    const offer = poolOffer(current, [better], heldOut, [], 0);
    expect(offer?.judgement.accepted).toBe(true);
    expect(offer?.judgement.proposedF1).toBe(1);
    const worse = poolOffer(
      current,
      [{ field: "subject", pattern: "lunch", predicts: true }],
      heldOut,
      [],
      0,
    );
    expect(worse?.judgement.accepted).toBe(false);
  });

  it("offers nothing while a hi-fi call is in flight", () => {
    expect(poolOffer(current, [better], heldOut, [], 1)).toBeNull();
  });

  it("leaves out a released rule no held-out item exercises", () => {
    // A NO exception aimed at a sender this person has not heard from yet
    const planted = {
      field: "from",
      pattern: "billing@bank\\.example",
      predicts: false,
    };
    const offer = poolOffer(current, [better, planted], heldOut, [], 0)!;
    expect(offer.judgement.rules.map((r) => r.pattern)).toEqual([
      "\\bbill\\b|invoice",
    ]);
    expect(offer.unexercised.map((r) => r.pattern)).toEqual([
      "billing@bank\\.example",
    ]);
    expect(offer.judgement.accepted).toBe(true);
    // A release of nothing but such rules offers nothing
    expect(poolOffer(current, [planted], heldOut, [], 0)).toBeNull();
  });

  it("offers nothing empty, nothing current, and nothing already judged", () => {
    expect(poolOffer(current, [], heldOut, [], 0)).toBeNull();
    expect(poolOffer(current, undefined, heldOut, [], 0)).toBeNull();
    expect(poolOffer(current, [current[0]], heldOut, [], 0)).toBeNull();
    const offer = poolOffer(current, [better], heldOut, [], 0)!;
    const judged = settle(current, 1, offer.judgement, [], 0, offer.key).entry;
    expect(judged.poolOffer).toBe(offer.key);
    expect(judged.reason).toMatch(/^the pool's rules: /);
    expect(poolOffer(current, [better], heldOut, [judged], 0)).toBeNull();
    // A different release, exercised, is a new offer
    expect(
      poolOffer(
        current,
        [better, { ...better, pattern: "lunch", predicts: false }],
        heldOut,
        [
          judged,
        ],
        0,
      ),
    ).not.toBeNull();
  });
});

describe("verdictsOf", () => {
  const graded = rows(
    [["mail-1", "bill", true], ["mail-6", "invoice", true]],
    [rule("subject", "invoice")],
  );

  it("words each item's labels, marking surprises and held-out items", () => {
    expect(verdictsOf(graded, true, true)).toEqual({
      "mail-1": { text: "lo-fi NO, hi-fi YES", surprise: true, heldOut: false },
      "mail-6": {
        text: "lo-fi YES, hi-fi YES",
        surprise: false,
        heldOut: true,
      },
    });
  });

  it("says there are no rules rather than NO, and no surprise", () => {
    expect(verdictsOf(graded, true, false)["mail-1"]).toEqual({
      text: "no rules yet, hi-fi YES",
      surprise: false,
      heldOut: false,
    });
  });

  it("says nothing with no question", () => {
    expect(verdictsOf(graded, false, true)["mail-1"]).toEqual({
      text: "",
      surprise: false,
      heldOut: false,
    });
  });
});

describe("shareable", () => {
  it("holds back adopted rules and rules that look personal", () => {
    const own = rule("subject", "invoice");
    const personal = rule("from", "billing@example\\.org");
    const adopted = rule("subject", "\\bbill\\b");
    expect(shareable([own, personal, adopted], [adopted.key])).toEqual({
      rules: [own],
      withheld: 1,
      adopted: 1,
    });
  });
});

describe("looksPersonal", () => {
  it("flags an @ or a run of six digits, and nothing generic", () => {
    expect(looksPersonal(rule("from", "pat@example\\.org"))).toBe(true);
    expect(looksPersonal(rule("from", "[@]"))).toBe(true);
    expect(looksPersonal(rule("subject", "order 1234567"))).toBe(true);
    expect(looksPersonal(rule("subject", "invoice"))).toBe(false);
    expect(looksPersonal(rule("subject", "\\d{6,}"))).toBe(false);
    expect(looksPersonal(rule("subject", "12345 due"))).toBe(false);
  });

  it("flags a run broken by separators, escaped or not, or written as a count", () => {
    for (
      const pattern of [
        "123-456-7890",
        "555 1234 5678",
        "555\\s1234\\s5678",
        "12345\\.6789",
        "\\(555\\) 123-4567",
        "1{6}",
        "12{5}",
        "acct 9{3}1{3}",
      ]
    ) {
      expect({ pattern, personal: looksPersonal(rule("subject", pattern)) })
        .toEqual({ pattern, personal: true });
    }
    for (
      const pattern of [
        "\\d{6}",
        "\\d{3}-\\d{3}-\\d{4}",
        "20\\d{2}",
        "\\s{0,88}x",
        "x{100}",
        "order\\s*#?\\s*\\d+",
        "\\$\\d+\\.\\d\\d",
        "1{5}",
        "12 34 5",
      ]
    ) {
      expect({ pattern, personal: looksPersonal(rule("subject", pattern)) })
        .toEqual({ pattern, personal: false });
    }
  });
});

describe("adoptedAfter", () => {
  const invoice = rule("subject", "invoice");
  const bill = rule("subject", "\\bbill\\b");
  const lunch = rule("subject", "lunch", false);
  const accept = (...rules: CanonicalRule[]) => ({ accepted: true, rules });

  it("marks a pool round's rules the person did not already hold", () => {
    expect(adoptedAfter([], [invoice], accept(invoice, bill), true))
      .toEqual([bill.key]);
    // A rejected round marks nothing
    expect(
      adoptedAfter([], [invoice], { accepted: false, rules: [bill] }, true),
    ).toEqual([]);
  });

  it("keeps a marked rule through a rewrite that keeps it, and nothing new", () => {
    const after = adoptedAfter(
      [bill.key],
      [invoice, bill],
      accept(bill, lunch),
      false,
    );
    expect(after).toEqual([bill.key]);
    // A rule the set drops is forgotten
    expect(adoptedAfter([bill.key], [invoice, bill], accept(lunch), false))
      .toEqual([]);
    // A later pool round leaves the person's own rules unmarked
    expect(
      adoptedAfter(
        [bill.key],
        [invoice, bill],
        accept(invoice, bill, lunch),
        true,
      )
        .sort(),
    ).toEqual([bill.key, lunch.key].sort());
  });
});

describe("sameGoal", () => {
  it("ignores case and surrounding or repeated space, and nothing else", () => {
    expect(sameGoal("Is this a bill?", "  is THIS   a bill? ")).toBe(true);
    expect(sameGoal("Is this a bill?", "Is this a bill")).toBe(false);
    expect(sameGoal("Is this a bill?", "Is this a newsletter?")).toBe(false);
    expect(sameGoal("", "  ")).toBe(false);
  });
});

describe("settle", () => {
  const current = [rule("subject", "invoice")];
  const judgement = judgeProposal(current, {
    rules: [{
      field: "subject",
      pattern: "invoice|\\bbill\\b",
      predicts: true,
    }],
  }, heldOutExamples(HELD_OUT_ROWS));

  it("adopts an accepted set and records the round", () => {
    const next = settle(current, 1, judgement, ["mail-1"], 1000);
    expect(next.rules).toEqual(judgement.rules);
    expect(next.entry).toEqual({
      round: 1,
      accepted: true,
      reason: judgement.reason,
      proposed: judgement.rules,
      refusals: [],
      currentF1: judgement.currentF1,
      proposedF1: 1,
      heldOut: 5,
      answered: ["mail-1"],
      decidedAt: 1000,
    });
  });

  it("keeps the current set when the round was rejected", () => {
    const next = settle(current, 2, { ...judgement, accepted: false }, [], 0);
    expect(next.rules).toEqual(current);
    expect(next.entry.accepted).toBe(false);
    expect(next.entry.round).toBe(2);
  });

  it("copies what it records rather than sharing it", () => {
    const next = settle(current, 1, judgement, ["mail-1"], 0);
    expect(next.entry.proposed[0]).not.toBe(judgement.rules[0]);
    expect(next.entry.refusals).not.toBe(judgement.refusals);
    expect(next.rules[0]).not.toBe(next.entry.proposed[0]);
  });
});

/**
 * The paths of the objects in `schema` that strict structured outputs refuse:
 * one that allows extra properties, or does not require every property.
 */
function strictFailures(schema: unknown, path = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const failures: string[] = [];
  if ("type" in schema && schema.type === "object") {
    const properties = "properties" in schema ? schema.properties : {};
    const keys = Object.keys(properties ?? {}).sort();
    const required = "required" in schema && Array.isArray(schema.required)
      ? [...schema.required].sort()
      : [];
    const closed = "additionalProperties" in schema &&
      schema.additionalProperties === false;
    if (!closed || keys.join() !== required.join()) failures.push(path);
  }
  for (const [key, value] of Object.entries(schema)) {
    for (const failure of strictFailures(value, `${path}.${key}`)) {
      failures.push(failure);
    }
  }
  return failures;
}

describe("prompts and text", () => {
  it("gives both model calls schemas strict providers take", () => {
    expect(strictFailures(HIFI_SCHEMA)).toEqual([]);
    expect(strictFailures(PROPOSAL_SCHEMA)).toEqual([]);
    // The check refuses a schema with an optional or an open object.
    expect(strictFailures({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
      additionalProperties: false,
    })).toEqual(["$"]);
    expect(strictFailures({
      type: "object",
      properties: { rules: { type: "array", items: { type: "object" } } },
      required: ["rules"],
      additionalProperties: false,
    })).toEqual(["$.properties.rules.items"]);
  });

  it("tells the rewrite model the backtracking limit", () => {
    expect(REWRITE_SYSTEM).toContain("unbounded quantifier");
    expect(REWRITE_SYSTEM).toContain("\\s*\\$");
  });

  it("asks the hi-fi model nothing without a goal", () => {
    expect(buildHifiPrompt("", item("a", "x"))).toBe("");
    expect(buildHifiPrompt("Is it a bill?", item("a", "x"))).toContain(
      '"subject": "x"',
    );
  });

  it("projects what the pattern holds as Markdown", () => {
    const text = markdownOf(
      "Is it a bill?",
      summarize(HELD_OUT_ROWS),
      [rule("subject", "invoice")],
      2 / 3,
      [],
    );
    expect(text).toContain("# Is it a bill?");
    expect(text).toContain("- `subject: /invoice/i → YES`");
    expect(text).toContain("held-out F1 67%");
  });
});
