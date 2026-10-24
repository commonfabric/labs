import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  buildCfHarnessBaseSystemPrompt,
  buildCfHarnessOperatorSystemPrompt,
} from "../src/cli.ts";
import {
  HELD_PIECES_GUIDANCE,
  MAY_HOLD_PIECES_GUIDANCE,
  PIECE_TARGETING_GUIDANCE,
} from "../src/piece-targeting.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "../src/revision-verification.ts";
import { orientContextMessages } from "../src/session-assembly.ts";
import { WEAVER_COMMAND_GUIDANCE } from "../src/tools/weaver-action.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";

describe("orientation", () => {
  it("tells the parent which explicit selections skip opening research", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "attached patternRefs or explicit pattern:<space>/<slug>, cf:pattern:<id>, or skill:<id> markers",
    );
    expect(prompt).toContain(
      "Prose such as 'use the named skill X' remains open unless X uses a marker",
    );
  });

  it("gives the parent a shared inspection path for calendar and document requests before asking for the source", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "inspect unresolved relevant handles with describe_handle before asking the user to connect or attach that source",
    );
    expect(prompt).toContain("A grant's name is a lead, not its contents");
    expect(prompt).toContain("not given does not mean absent");
    expect(prompt).toContain(
      "The parent can run an indexed pattern with run_pattern",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "any applicable bounded discovery route over the granted scope",
    );
  });

  it("tells a run with no pattern index neither to search one nor to run an indexed pattern, and keeps the rest of finding", () => {
    const withIndex = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: false });
    expect(withIndex).toContain("Search the pattern index");
    expect(prompt).not.toContain("pattern index");
    expect(prompt).not.toContain("indexed pattern");
    expect(prompt).toContain("not given does not mean absent");
    expect(prompt).toContain(
      "Research is a private pass that reads docs and source",
    );
  });

  it("checks the send path before asking for a recipient in the landlord-email rehearsal", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "Before asking for a recipient or other execution detail, establish that an available tool, skill, or pattern can perform the action with the held authority",
    );
    expect(prompt).toContain(
      "If sending is unavailable, say so immediately and offer a draft",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "rather than asking for an address as though that enables sending",
    );
  });

  it("keeps discovery scoped and a release refusal out of the question path", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(PIECE_TARGETING_GUIDANCE).toContain("call resolve_piece");
    expect(PIECE_TARGETING_GUIDANCE).toContain("make zero registry reads");
    expect(PIECE_TARGETING_GUIDANCE).toContain("at most one registry read");
    expect(PIECE_TARGETING_GUIDANCE).toContain(
      "not to an explicit request to list or analyze the space",
    );
    expect(prompt).toContain(
      "An unavailable, refused, or pending read stays unknown",
    );
    expect(prompt).toContain(
      "Inspect run_pattern outputConcerns and the declared error branch",
    );
    expect(prompt).toContain(
      "Describe only the successfully applied change, say the result could not be inspected",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "Never ask for a nonexistent permission to release results",
    );
  });

  describe("without finish_task", () => {
    it("names finish_task to a run that holds it and to no other", () => {
      const holding = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        allowedToolIds: ["finish_task", "submit_result"],
      });
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        allowedToolIds: ["submit_result"],
      });

      expect(holding).toContain("Use finish_task to ask the user");
      expect(prompt).not.toContain("finish_task");
      expect(PIECE_TARGETING_GUIDANCE).not.toContain("finish_task");
      expect(REVISION_VERIFICATION_GUIDANCE).not.toContain("finish_task");
    });

    it("tells a run that cannot ask to act on defaults and say in its result why it cannot go on", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        allowedToolIds: ["submit_result"],
      });

      expect(prompt).toContain("Act on reasonable defaults rather than asking");
      expect(prompt).toContain("finish with a result that says why");
      expect(prompt).toContain(
        "Where other guidance says to ask the user, say in your result what you need instead",
      );
    });
  });

  describe("with task tags", () => {
    it("gives a respond task none of the handle, research, or delegation guidance", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["respond"]),
      });

      expect(prompt).not.toContain("describe_handle");
      expect(prompt).not.toContain("opening research");
      expect(prompt).not.toContain("Search the pattern index");
      expect(prompt).not.toContain("When you delegate");
      expect(prompt).toContain("Orient to the user's goal");
      expect(prompt.length).toBeLessThan(
        buildCfHarnessBaseSystemPrompt({ patternIndex: true }).length,
      );
    });

    it("gives respond, find, and act tasks the identity and the closing on evidence and authority, without the code-authoring framing", () => {
      for (const tag of ["respond", "find", "act"] as const) {
        const prompt = buildCfHarnessBaseSystemPrompt({
          patternIndex: true,
          tags: new Set([tag]),
        });

        expect(prompt).toContain("You are cf-harness");
        expect(prompt).toContain("Treat tool results as evidence");
        expect(prompt).toContain(
          "Respect explicit user/developer instructions",
        );
        expect(prompt).not.toContain("read relevant docs and skill resources");
        expect(prompt).not.toContain("run focused verification commands");
        expect(prompt).not.toContain("When code verification fails");
        expect(prompt).not.toContain("repository files");
        expect(prompt).not.toContain("A skill named by an exact id");
      }
    });

    it("gives pieces and author tasks the code-authoring framing", () => {
      for (const tag of ["pieces", "author"] as const) {
        const prompt = buildCfHarnessBaseSystemPrompt({
          patternIndex: true,
          tags: new Set([tag]),
        });

        expect(prompt).toContain("read relevant docs and skill resources");
        expect(prompt).toContain(
          "Treat repository files and tool results as evidence",
        );
        expect(prompt).toContain("A skill named by an exact id");
      }
    });

    it("narrows the operator prompt by the task's tags", () => {
      const config = { workspace: "/workspace", focusRoot: "/workspace" };

      expect(buildCfHarnessOperatorSystemPrompt({
        ...config,
        taskTags: new Set(["respond"]),
      })).not.toContain("When you delegate");
      expect(buildCfHarnessOperatorSystemPrompt(config))
        .toContain("When you delegate");
    });

    it("gives a pieces task the handle guidance and not the opening-research rule", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["pieces"]),
      });

      expect(prompt).toContain(
        "inspect unresolved relevant handles with describe_handle",
      );
      expect(prompt).not.toContain("opening research");
    });

    it("gives a find task the instruction to inspect held handles and grants", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["find"]),
      });

      expect(prompt).toContain("A grant's name is a lead, not its contents");
      expect(prompt).not.toContain("When you delegate");
    });

    it("gives a pieces task the delegation guidance", () => {
      expect(
        buildCfHarnessBaseSystemPrompt({
          patternIndex: true,
          tags: new Set(["pieces"]),
        }),
      ).toContain("When you delegate");
    });

    it("says what research is once, and only to an author task", () => {
      const find = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["find"]),
      });
      const author = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["author"]),
      });

      expect(find).not.toContain("Research is");
      expect(find).not.toContain("Private research");
      expect(find).not.toContain("call research");
      expect(author.split("Research is a private pass").length).toBe(2);
      expect(author).toContain(
        "A fresh task eligible for opening research gets one pass",
      );
      expect(author).toContain(
        "reads the pattern index, docs, and source and reports what to run; it cannot execute anything",
      );
      expect(author).toContain(
        "call research for a specific unresolved question",
      );
      expect(author).not.toContain("Private research inspects candidates");
    });

    it("cites no piece-targeting bounds to a find task, which is not sent them", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["find"]),
      });

      expect(prompt).not.toContain("piece-targeting");
      expect(prompt).not.toContain("resolve_piece");
    });

    it("gives an author task the opening-research rule, index search, and delegation", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["author"]),
      });

      expect(prompt).toContain("attached patternRefs or explicit");
      expect(prompt).toContain("Search the pattern index");
      expect(prompt).toContain("When you delegate");
    });

    it("keeps the Weaver's commands for a find task and withholds them from a respond task", () => {
      const messages = ["input cells", WEAVER_COMMAND_GUIDANCE];

      expect(
        orientContextMessages(messages, {
          tags: new Set(["find"]),
          depth: "standard",
        }),
      )
        .toEqual(messages);
      expect(
        orientContextMessages(messages, {
          tags: new Set(["respond"]),
          depth: "standard",
        }),
      )
        .toEqual(["input cells"]);
    });

    describe("held pieces", () => {
      const messages = [
        "input cells",
        PIECE_TARGETING_GUIDANCE,
        REVISION_VERIFICATION_GUIDANCE,
      ];

      it("gives a pieces task the held-pieces block in place of piece targeting and revision verification", () => {
        expect(
          orientContextMessages(messages, {
            tags: new Set(["pieces"]),
            depth: "standard",
          }),
        )
          .toEqual(["input cells", HELD_PIECES_GUIDANCE]);
      });

      it("gives a respond, find, or act task one sentence about held handles", () => {
        for (const tag of ["respond", "find", "act"] as const) {
          expect(
            orientContextMessages(messages, {
              tags: new Set([tag]),
              depth: "standard",
            }),
          )
            .toEqual(["input cells", MAY_HOLD_PIECES_GUIDANCE]);
        }
      });

      it("keeps piece targeting and revision verification for an author task", () => {
        expect(
          orientContextMessages(messages, {
            tags: new Set(["author"]),
            depth: "standard",
          }),
        )
          .toEqual([
            "input cells",
            MAY_HOLD_PIECES_GUIDANCE,
            PIECE_TARGETING_GUIDANCE,
            REVISION_VERIFICATION_GUIDANCE,
          ]);
        expect(
          orientContextMessages(messages, {
            tags: new Set(["pieces", "author"]),
            depth: "standard",
          }),
        ).toEqual([
          "input cells",
          HELD_PIECES_GUIDANCE,
          PIECE_TARGETING_GUIDANCE,
          REVISION_VERIFICATION_GUIDANCE,
        ]);
      });

      it("names the input cells by where the pieces are and the tools that read and act on them", () => {
        expect(HELD_PIECES_GUIDANCE).toContain("focused_piece");
        expect(HELD_PIECES_GUIDANCE).toContain("on_screen_");
        expect(HELD_PIECES_GUIDANCE).toContain("in_loom_");
        expect(HELD_PIECES_GUIDANCE).toContain("describe_handle");
        expect(HELD_PIECES_GUIDANCE).toContain("read_value");
        expect(HELD_PIECES_GUIDANCE).toContain("call_verb");
        expect(HELD_PIECES_GUIDANCE.length).toBeLessThan(600);
      });
    });

    it("tells only an author task to verify what it did", () => {
      const pieces = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["pieces"]),
      });
      const author = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["author"]),
      });

      expect(pieces).not.toContain("verification");
      expect(pieces).not.toContain("verify");
      expect(author).toContain("run focused verification commands");
      expect(author).toContain("When code verification fails");
      expect(author).toContain("include concise verification details");
    });
  });
});
