import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { HarnessPatternRef } from "../src/contracts/pattern-refs.ts";
import {
  DOMAIN_TASKS,
  PLAYTEST_2026_10_13_TASKS,
} from "./task-classification-cases.ts";
import {
  classifyTask,
  classifyTaskByModel,
  classifyTaskByRule,
  HARNESS_TASK_TAGS,
  type HarnessTaskTag,
} from "../src/task-classification.ts";

const cell = (name: string) => ({
  name,
  token: `cfh:a:${name.toLowerCase().replaceAll(" ", "-")}`,
  ref: `of:fid1:${name.length}`,
});

const attachedPattern = {
  patternId: "v6_KSFHs9AmTg9PKwMmPdZyEHxZ9Oykhno4HBOfUo5s",
} as HarnessPatternRef;

const tagsOf = (tags: ReadonlySet<HarnessTaskTag> | undefined) =>
  tags === undefined ? undefined : [...tags].sort();

describe("task-classification", () => {
  describe("classifyTaskByRule()", () => {
    it("returns respond for short conversational text", () => {
      expect(tagsOf(classifyTaskByRule("thanks!", {}))).toEqual(["respond"]);
    });

    it("returns pieces for an attached pattern ref", () => {
      expect(tagsOf(classifyTaskByRule("Rename it.", {
        patternRefs: [attachedPattern],
      }))).toEqual(["pieces"]);
    });

    it("returns pieces for a request naming a held input cell", () => {
      expect(tagsOf(classifyTaskByRule("add socks to my packing list", {
        inputCells: [cell("Packing List")],
      }))).toEqual(["pieces"]);
    });

    it("returns find and act for navigation to a loom", () => {
      expect(tagsOf(classifyTaskByRule("take me to the lunch poll loom", {})))
        .toEqual(["act", "find"]);
    });

    it("returns find for a question", () => {
      expect(tagsOf(classifyTaskByRule("what's on Thursday?", {})))
        .toEqual(["find"]);
    });

    it("returns find for a URL", () => {
      expect(
        tagsOf(classifyTaskByRule("https://example.com/menu dinner", {})),
      ).toEqual(["find"]);
    });

    it("returns author for a request to make something new", () => {
      expect(tagsOf(classifyTaskByRule("make me a pomodoro timer", {})))
        .toEqual(["author"]);
    });

    it("returns act for a web purchase when a browser is attached", () => {
      expect(
        tagsOf(
          classifyTaskByRule("buy the cheapest oat milk", {
            browserHost: true,
          }),
        ),
      ).toEqual(["act"]);
    });

    it("returns find, not pieces, when a request shares only a generic word with a held piece's name", () => {
      expect(tagsOf(classifyTaskByRule("list my favorite colors", {
        inputCells: [cell("Packing List")],
      }))).toEqual(["find"]);
    });

    it("returns pieces for a request naming a held piece with a non-Latin name", () => {
      expect(tagsOf(classifyTaskByRule("add a stop to 東京", {
        inputCells: [cell("東京")],
      }))).toEqual(["pieces"]);
    });

    it("keeps author for a request to make something new beside an attached pattern", () => {
      expect(tagsOf(classifyTaskByRule("make me a new tracker", {
        patternRefs: [attachedPattern],
      }))).toEqual(["author", "pieces"]);
    });

    it("keeps find for a question beside an attached pattern", () => {
      expect(tagsOf(classifyTaskByRule("what's on Thursday?", {
        patternRefs: [attachedPattern],
      }))).toEqual(["find", "pieces"]);
    });

    it("returns act and find for browsing the web", () => {
      expect(
        tagsOf(classifyTaskByRule("browse the web for recent studies", {
          browserHost: true,
        })),
      ).toEqual(["act", "find"]);
    });

    it("returns act, not author, for making a reservation", () => {
      expect(
        tagsOf(classifyTaskByRule("make me a reservation at Zuni", {
          browserHost: true,
        })),
      ).toEqual(["act"]);
    });

    it("returns act and find for opening a URL", () => {
      expect(tagsOf(classifyTaskByRule("open https://example.com", {})))
        .toEqual(["act", "find"]);
    });

    it("returns undefined for a polite request for an action rather than calling it a question", () => {
      expect(
        classifyTaskByRule("Can you add an appointment to my calendar?", {}),
      ).toBeUndefined();
    });

    it("does not return author for making a new note or a new loom", () => {
      for (
        const task of [
          "make me a new note called Test",
          "make a new loom for the trip",
          "create new note",
        ]
      ) {
        expect(tagsOf(classifyTaskByRule(task, {})) ?? []).not.toContain(
          "author",
        );
      }
      expect(tagsOf(classifyTaskByRule("make me a new tracker", {})))
        .toEqual(["author"]);
    });

    it("does not read this weekend as pointing at a held piece", () => {
      expect(
        tagsOf(
          classifyTaskByRule("make a loom with ideas for a walk this weekend", {
            inputCells: [cell("Pomodoro Timer")],
          }),
        ) ?? [],
      ).not.toContain("pieces");
    });

    it("returns undefined when no rule applies", () => {
      expect(classifyTaskByRule("the quarterly numbers for Q3 sales", {}))
        .toBeUndefined();
    });
  });

  describe("classifyTask()", () => {
    it("records the rule path when a rule applies", () => {
      const classification = classifyTask("what's on Thursday?", {});

      expect(classification.path).toBe("rule");
      expect(classification.tags).toEqual(["find"]);
      expect(classification.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("returns find by the assumed path when no rule applies", () => {
      const classification = classifyTask("weather in Brisbane", {});

      expect(classification.path).toBe("assumed");
      expect(classification.tags).toEqual(["find"]);
    });

    it("adds pieces to an assumed find when the run holds input cells", () => {
      const classification = classifyTask("weather in Brisbane", {
        inputCells: [cell("Budget")],
      });

      expect(classification.path).toBe("assumed");
      expect(classification.tags).toEqual(["find", "pieces"]);
    });

    it("adds act to an assumed find for an action verb when a browser is attached", () => {
      const withBrowser = classifyTask("move the quarterly numbers", {
        browserHost: true,
      });
      const withoutBrowser = classifyTask("move the quarterly numbers", {});

      expect(withBrowser.path).toBe("assumed");
      expect(withBrowser.tags).toEqual(["find", "act"]);
      expect(withoutBrowser.tags).toEqual(["find"]);
    });

    it("falls back to every tag when the rule throws", () => {
      const classification = classifyTask("weather in Brisbane", {
        inputCells: [{
          get name(): string {
            throw new Error("unreadable cell");
          },
          token: "cfh:a:unreadable",
          ref: "of:fid1:unreadable",
        }],
      });

      expect(classification.path).toBe("fallback");
      expect(classification.tags).toEqual([...HARNESS_TASK_TAGS]);
    });

    it("records only the tags, the domains, what chose each, and the wall time", () => {
      expect(Object.keys(classifyTask("weather in Brisbane", {})).sort())
        .toEqual([
          "domains",
          "domainsPath",
          "durationMs",
          "path",
          "tags",
          "type",
          "version",
        ]);
    });
  });

  describe("classifyTaskByModel()", () => {
    it("tells the model what the run holds, or that it holds nothing", async () => {
      const prompts: string[] = [];
      const ask = (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve("act");
      };

      await classifyTaskByModel("book it", {
        patternRefs: [attachedPattern],
        browserHost: true,
      }, ask);
      await classifyTaskByModel("book it", {}, ask);

      expect(prompts[0]).toContain(
        "The agent holds: 1 attached pattern(s), a web browser.",
      );
      expect(prompts[1]).toContain("The agent holds: nothing.");
    });
  });

  describe("the verb asks of 2026-10-15", () => {
    // Two asks typed on a focused Ring Loops piece, each of which a model
    // call failed to tag within its bound.

    const ringLoops = {
      inputCells: [cell("focused_piece"), cell("in_loom_iframe_ring_loops")],
    };

    for (
      const task of [
        "use the addnotes verb to add hihats",
        "add a basic hihat loop to the music",
      ]
    ) {
      it(`returns act and pieces by rule for ${JSON.stringify(task)}`, () => {
        const classification = classifyTask(task, ringLoops);

        expect(classification.path).toBe("rule");
        expect(classification.tags).toEqual(["act", "pieces"]);
        expect(classification.durationMs).toBeLessThan(1);
      });
    }

    it("does not return act for a question about a held piece's verbs", () => {
      expect(
        tagsOf(
          classifyTaskByRule("what verbs does the music have?", ringLoops),
        ),
      ).not.toContain("act");
    });

    it("does not read adding to something as acting on a piece when the run holds none", () => {
      expect(classifyTaskByRule("add a basic hihat loop to the music", {}))
        .toBeUndefined();
    });
  });

  describe("the playtest asks of 2026-10-13", () => {
    // Each ask as typed on the playtest sheet, with what the job held, and
    // the tags its work called for. The rule must answer every one well
    // inside the time a model call would take.

    const cases = PLAYTEST_2026_10_13_TASKS;

    for (const { task, context, expected } of cases) {
      it(`returns ${expected.join(", ")} for ${JSON.stringify(task)}`, () => {
        expect(tagsOf(classifyTaskByRule(task, context))).toEqual(expected);
      });
    }

    it("answers the whole set by rule in well under 100 ms", () => {
      const started = performance.now();
      for (const { task, context } of cases) {
        classifyTaskByRule(task, context);
      }

      expect(performance.now() - started).toBeLessThan(100);
    });
  });

  describe("domains", () => {
    // Where each ask's work happens: the playtest asks, and asks that reach
    // past the pieces a job holds. Only a positive sign names a domain.
    for (
      const { task, context, expected, domains } of [
        ...PLAYTEST_2026_10_13_TASKS,
        ...DOMAIN_TASKS,
      ]
    ) {
      it(
        `places ${JSON.stringify(task)} in ${
          domains.join(", ") || "no domain"
        }`,
        () => {
          const classification = classifyTask(task, context);

          expect(classification.domains).toEqual(domains);
          expect(classification.domainsPath).toBe(
            domains.length === 0 ? "assumed" : "rule",
          );
          expect([...classification.tags].sort()).toEqual([...expected].sort());
        },
      );
    }

    it("reads the fabric in a pattern named beside one of its parts in either order", () => {
      expect(classifyTask("How do pattern handlers work?", {}).domains)
        .toEqual(["fabric"]);
      expect(classifyTask("How do handlers in a pattern work?", {}).domains)
        .toEqual(["fabric"]);
      expect(classifyTask("knit a scarf in a herringbone pattern", {}).domains)
        .toEqual([]);
      expect(classifyTask("which loom holds the timer pattern?", {}).domains)
        .toEqual(["fabric"]);
    });

    it("needs a sign the data is the person's own, not a bare noun", () => {
      expect(classifyTask("What is a calendar?", {}).domains).toEqual([]);
      expect(classifyTask("How can I meet the deadline?", {}).domains)
        .toEqual([]);
      expect(classifyTask("what is the message of the Gospel?", {}).domains)
        .toEqual([]);
      expect(classifyTask("Compare email providers", {}).domains).toEqual([
        "web",
      ]);
      expect(classifyTask("what's on my work calendar?", {}).domains).toEqual([
        "personal",
      ]);
    });

    it("puts a web purchase on the web only when the run can drive a browser", () => {
      expect(classifyTask("buy the cheapest oat milk", {}).domains).toEqual([]);
      expect(
        classifyTask("buy the cheapest oat milk", { browserHost: true })
          .domains,
      ).toEqual(["web"]);
    });

    it("reads a request to research as the web's only when it names no other domain", () => {
      expect(classifyTask("research how my week went", {}).domains).toEqual([
        "personal",
      ]);
      expect(classifyTask("research heat pumps", {}).domains).toEqual(["web"]);
    });
  });

  describe("a caller's task shape", () => {
    it("takes the caller's tags in place of the rule's, and still names domains by their signs", () => {
      const classification = classifyTask(
        "What's on my calendar tomorrow?",
        {},
        {
          tags: ["act"],
        },
      );

      expect(classification).toMatchObject({
        tags: ["act"],
        path: "caller",
        domains: ["personal"],
        domainsPath: "rule",
      });
    });

    it("takes the caller's domains in place of the rule's, and still tags by rule", () => {
      const classification = classifyTask(
        "What's on my calendar tomorrow?",
        {},
        {
          domains: ["web"],
        },
      );

      expect(classification).toMatchObject({
        tags: ["find"],
        path: "rule",
        domains: ["web"],
        domainsPath: "caller",
      });
    });

    it("takes an empty list from the caller as no domain at all", () => {
      expect(
        classifyTask("make me a pomodoro timer", {}, { domains: [] }),
      ).toMatchObject({
        tags: ["author"],
        domains: [],
        domainsPath: "caller",
      });
    });

    it("classifies exactly as without a caller when the caller states nothing", () => {
      for (const { task, context } of DOMAIN_TASKS) {
        const { durationMs: _alone, ...alone } = classifyTask(task, context);
        const { durationMs: _empty, ...empty } = classifyTask(
          task,
          context,
          {},
        );

        expect(empty).toEqual(alone);
      }
    });
  });
});
