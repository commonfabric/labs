import { expect } from "@std/expect";
import { nothing } from "lit";
import {
  clampSelection,
  ConsoleSteps,
  stepPolicyView,
  withheldSummary,
  withheldView,
} from "../../../console/src/steps-view.ts";
import {
  type ConsoleHandle,
  consoleRunSteps,
  type ConsoleStep,
} from "../../../console/steps.ts";
import type { HarnessTranscriptMessage } from "../../../src/contracts/transcript.ts";
import { createToolOutputId } from "../../../src/contracts/tool-result.ts";
import {
  bindingOn,
  handlerOn,
  templateBindings,
  templateText,
} from "./lit-template.ts";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

describe("console/src/steps-view", () => {
  describe("clampSelection", () => {
    it("keeps a selection the run is long enough to hold", () => {
      expect(clampSelection(3, 9)).toBe(3);
    });

    it("moves a selection past a shorter run's end to its last step", () => {
      expect(clampSelection(8, 3)).toBe(2);
    });

    it("answers zero for a run that recorded no steps", () => {
      expect(clampSelection(8, 0)).toBe(0);
    });

    it("answers zero for a step before the first", () => {
      expect(clampSelection(-1, 9)).toBe(0);
    });
  });

  describe("stepPolicyView", () => {
    const step = (policy?: ConsoleStep["policy"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      toolName: "read_file",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld: { status: "recorded", locations: [] },
      ...(policy === undefined ? {} : { policy }),
    });

    it("renders nothing for a step whose run recorded no CFC decision", () => {
      // A step with no decision, no event and no labels has no CFC pane to
      // draw, and an empty one would read as a decision that was not made.
      expect(stepPolicyView(step())).toBe(nothing);
    });

    it("renders the decision and its reasons for a step that carries one", () => {
      const text = templateText(stepPolicyView(step({
        decision: "allowed",
        effectClass: "side-effect",
        reasonCodes: ["cfc_enforce_explicit_direct_command"],
      })));

      expect(text).toContain("allowed");
      expect(text).toContain("side-effect");
      expect(text).toContain("cfc_enforce_explicit_direct_command");
    });

    it("lists the prompt slot's influence as integrity on the path it names", () => {
      const text = templateText(stepPolicyView({
        ...step(),
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "bash",
          operation: "shell",
          cfcEnforcementMode: "enforce-strict",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          promptSlotInfluenceLabels: {
            version: 1,
            entries: [{
              path: ["command"],
              label: {
                integrity: [{
                  type: "https://commonfabric.org/cfc/atom/PromptSlotInfluence",
                  version: 1,
                }],
              },
            }],
          },
        },
      }));

      expect(text).toContain("command");
      expect(text).toContain("PromptSlotInfluence");
      // An integrity-only row carries no taint and says nothing about its
      // absence.
      expect(text).not.toContain("no confidentiality atom");
    });

    it("renders a denial with the denied badge, and an invalid decision with a warning", () => {
      const denied = templateText(stepPolicyView(step({
        decision: "denied",
        reasonCodes: ["cfc_denied"],
      })));
      const invalid = templateText(stepPolicyView(step({
        decision: "invalid",
        reasonCodes: [],
      })));

      expect(denied).toMatch(/class="badge denied"\s*>denied</);
      expect(denied).not.toContain("cfc-effect");
      expect(invalid).toMatch(/class="badge warn"\s*>invalid</);
      expect(invalid).not.toContain("withheld by policy");
    });

    it("renders each policy event with a badge for its severity", () => {
      const event = {
        type: "cf-harness.policy-event" as const,
        mode: "observe" as const,
        toolId: "bash",
        at: "2026-01-01T00:00:00.000Z",
      };
      const text = templateText(stepPolicyView({
        ...step(),
        policyEvents: [
          { ...event, severity: "denied", detail: "sink refused" },
          { ...event, severity: "warning", detail: "observed" },
        ],
      })).replace(/\s+/g, " ");

      expect(text).toContain(
        '<span class="badge denied" >denied</span> <span class="cfc-reasons">sink refused</span>',
      );
      expect(text).toContain(
        '<span class="badge warn" >warning</span> <span class="cfc-reasons">observed</span>',
      );
    });

    it("names each input label's atoms, by shape for a clause that is not a typed atom", () => {
      const text = templateText(stepPolicyView({
        ...step(),
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "r",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "bash",
          operation: "shell",
          cfcEnforcementMode: "enforce-strict",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [
                  { type: "https://commonfabric.org/cfc/atom/ExternalIngest" },
                  { level: 3 },
                ],
              },
            }, { path: ["env", "HOME"], label: {} }],
          },
        },
      })).replace(/\s+/g, " ");

      expect(text).toContain("(whole input)");
      expect(text).toContain('<span class="atom conf">ExternalIngest</span>');
      expect(text).toContain('<span class="atom conf">{"level":3}</span>');
      expect(text).toContain(
        'env.HOME </td> <td class="label-atoms"> <span class="muted">no confidentiality atom</span>',
      );
      expect(text.match(/no confidentiality atom/g)).toHaveLength(1);
    });
  });

  describe("withheldSummary", () => {
    const step = (withheld: ConsoleStep["withheld"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld,
    });

    it("labels a legacy result as having no omission record", () => {
      expect(withheldSummary(step({ status: "unrecorded", locations: [] })))
        .toBe("model omissions · no record");
    });

    it("labels a recorded result with its withheld position count", () => {
      expect(withheldSummary(step({
        status: "recorded",
        locations: [{
          rule: "artifact-only",
          artifactPath: "/run/tool-outputs/result.json",
          jsonPointer: "/rawValue",
          value: "retained",
          available: true,
        }],
      }))).toBe("kept on the artifact, not sent to the model · 1");
    });

    it("labels policy-denied observations by their rule", () => {
      expect(withheldSummary(step({
        status: "recorded",
        locations: [{
          rule: "observation-denied",
          artifactPath: "/run/tool-outputs/result.json",
          jsonPointer: "/stdout",
          redaction: "[redacted by CFC]",
          available: true,
        }],
      }))).toBe("withheld by policy · 1");
    });

    it("labels a recorded result no omission rule applied to with a count of zero", () => {
      expect(withheldSummary(step({ status: "recorded", locations: [] })))
        .toBe("model omissions · 0");
    });

    it("distinguishes an unreadable record from a missing result entry", () => {
      expect(withheldSummary(step({
        status: "record-unreadable",
        locations: [],
      }))).toContain("record unreadable");
      expect(withheldSummary(step({
        status: "record-entry-missing",
        locations: [],
      }))).toContain("entry missing");
    });
  });

  describe("withheldView", () => {
    const step = (withheld: ConsoleStep["withheld"]): ConsoleStep => ({
      index: 1,
      kind: "tool",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld,
    });

    it("explains why a legacy result cannot be reconstructed", () => {
      const text = templateText(withheldView(step({
        status: "unrecorded",
        locations: [],
      })));
      expect(text).toContain("model omissions · no record");
      expect(text).toContain("Legacy runs cannot be");
      expect(text).toContain("reconstructed honestly");
    });

    it("states when a recorded result has no omissions", () => {
      const text = templateText(withheldView(step({
        status: "recorded",
        locations: [],
      })));
      expect(text).toContain("No omission rule applied to this result");
      expect(text).not.toContain("withheld by policy");
      expect(text).not.toContain("kept on the artifact");
    });

    it("does not describe a bad or incomplete current record as legacy", () => {
      const unreadable = templateText(withheldView(step({
        status: "record-unreadable",
        locations: [],
      })));
      const incomplete = templateText(withheldView(step({
        status: "record-entry-missing",
        locations: [],
      })));

      expect(unreadable).toContain("exists but is unreadable");
      expect(incomplete).toContain("exists but has no entry");
      expect(unreadable).not.toContain("Legacy");
      expect(incomplete).not.toContain("Legacy");
    });

    it("renders values, redaction markers, and unavailable positions", () => {
      const text = templateText(withheldView(step({
        status: "recorded",
        locations: [{
          rule: "artifact-only",
          artifactPath: "/run/output.json",
          jsonPointer: "/rawValue",
          value: { retained: true },
          available: true,
        }, {
          rule: "observation-denied",
          artifactPath: "/run/output.json",
          jsonPointer: "/stderr",
          redaction: "[redacted by CFC]",
          available: true,
        }, {
          rule: "model-context-truncation",
          artifactPath: "/run/missing.json",
          jsonPointer: "/stdout",
          available: false,
        }],
      })));
      expect(text).toContain("kept on the artifact, not sent to the model");
      expect(text).toContain("withheld by policy");
      expect(text).toContain("model-context-truncation");
      expect(text).toContain('{\n  "retained": true\n}');
      expect(text).toContain("[redacted by CFC]");
      expect(text).toContain("recorded artifact position is unavailable");
      expect(text).not.toContain("Model received:");
    });

    it("renders the model's text result, elided past two hundred characters", () => {
      const location = {
        rule: "artifact-only" as const,
        artifactPath: "/run/output.json",
        jsonPointer: "/rawValue",
        value: "retained",
        available: true,
      };
      const short = templateText(withheldView({
        ...step({ status: "recorded", locations: [location] }),
        outputText: "plain text",
      }));
      const long = templateText(withheldView({
        ...step({ status: "recorded", locations: [location] }),
        outputText: "x".repeat(300),
      }));

      expect(short).toContain("Model received: plain text");
      expect(long).toContain(`Model received: ${"x".repeat(199)}…</p>`);
    });

    it("never renders an available denied value through an overlapping rule", () => {
      const outputId = createToolOutputId("run", "bash", 1);
      const artifactPath = "/run/tool-outputs/bash.json";
      const transcript: HarnessTranscriptMessage[] = [{
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"echo"}' },
        }],
      }, {
        role: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        content: "model-facing",
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId,
          toolId: "bash",
          runId: "run",
          artifactPath,
        },
      }];
      const locations = [{ artifactPath, jsonPointer: "/stdout" }];
      const joined = consoleRunSteps(
        transcript,
        [],
        [],
        [],
        {
          type: "cf-harness.transcript-omissions",
          version: 1,
          results: [{
            transcriptIndex: 1,
            toolCallId: "call-1",
            toolId: "bash",
            outputId,
            rules: [{ rule: "artifact-only", locations }, {
              rule: "observation-denied",
              locations,
            }],
          }],
        },
        [{ artifactPath, value: { stdout: "PLANTED-SECRET" } }],
      );
      const text = templateText(withheldView(joined[0]));

      expect(text.match(/\[redacted by CFC\]/g)).toHaveLength(2);
      expect(text).not.toContain("PLANTED-SECRET");
      expect(text).toContain("Model received: model-facing");
    });
  });

  describe("ConsoleSteps", () => {
    class TestConsoleSteps extends ConsoleSteps {
      view() {
        return this.render();
      }

      /**
       * A connected view schedules updates, and committing one needs a DOM to
       * write into. These tests render by calling `view()` themselves.
       */
      protected override performUpdate(): void {}

      /** Runs the update Lit makes after `changed` properties changed. */
      changed(...names: string[]): void {
        this.willUpdate(new Map(names.map((name) => [name, undefined])));
      }

      /** The `detail` of every `name` event the view has dispatched. */
      dispatched(name: string): unknown[] {
        const details: unknown[] = [];
        this.addEventListener(name, (event) => {
          details.push(event instanceof CustomEvent ? event.detail : event);
        });
        return details;
      }
    }

    const toolStep = (
      index: number,
      over: Partial<ConsoleStep> = {},
    ): ConsoleStep => ({
      index,
      kind: "tool",
      toolName: "read_file",
      handlesIntroduced: [],
      handlesInScope: [],
      status: "ok",
      policyEvents: [],
      withheld: { status: "recorded", locations: [] },
      ...over,
    });

    const showing = (
      steps: readonly ConsoleStep[],
      handles: readonly ConsoleHandle[] = [],
    ): TestConsoleSteps => {
      const view = new TestConsoleSteps();
      view.steps = steps;
      view.handles = handles;
      return view;
    };

    const shown = (view: TestConsoleSteps): string =>
      templateText(view.view()).replace(/\s+/g, " ");

    it("renders a note for a run that recorded no transcript", () => {
      expect(shown(showing([]))).toContain("This run recorded no transcript.");
    });

    it("moves the selection to the last step when fewer steps arrive", () => {
      const view = showing([toolStep(0), toolStep(1)]);
      view.selected = 5;

      view.changed("handles");
      expect(view.selected).toBe(5);

      view.changed("steps");
      expect(view.selected).toBe(1);
    });

    describe("scrubbing", () => {
      it("moves the selection and announces it when a rail step is clicked", () => {
        const view = showing([toolStep(0), toolStep(1), toolStep(2)]);
        const announced = view.dispatched("step-selected");

        handlerOn(view.view(), "@click", "2", "button")();

        expect(view.selected).toBe(2);
        expect(announced).toEqual([2]);
        expect(shown(view)).toContain("step 2 of 2");
        expect(shown(view)).toMatch(/class="step open"[^]*?step-index">2</);
      });

      it("steps back and forward with the scrubber's buttons, disabled at either end", () => {
        const view = showing([toolStep(0), toolStep(1)]);
        expect(bindingOn(view.view(), "?disabled", "‹")).toBe(true);
        expect(bindingOn(view.view(), "?disabled", "›")).toBe(false);

        handlerOn(view.view(), "@click", "›")();
        expect(view.selected).toBe(1);
        expect(bindingOn(view.view(), "?disabled", "‹")).toBe(false);
        expect(bindingOn(view.view(), "?disabled", "›")).toBe(true);

        handlerOn(view.view(), "@click", "‹")();
        expect(view.selected).toBe(0);
      });

      it("moves to where the range input was dragged, within the run", () => {
        const view = showing([toolStep(0), toolStep(1), toolStep(2)]);
        const drag = handlerOn(view.view(), "@input", "", "input");

        drag({ target: { value: "1" } });
        expect(view.selected).toBe(1);

        drag({ target: { value: "9" } });
        expect(view.selected).toBe(2);
      });

      describe("arrow keys", () => {
        const views: TestConsoleSteps[] = [];

        afterEach(() => {
          for (const view of views.splice(0)) view.disconnectedCallback();
        });

        const connected = (count: number): TestConsoleSteps => {
          const view = showing(
            Array.from({ length: count }, (_, index) => toolStep(index)),
          );
          views.push(view);
          view.connectedCallback();
          return view;
        };

        /** Presses `key` on the page, with focus on `target` if given. */
        const press = (key: string, target?: Record<string, unknown>) => {
          const event = new Event("keydown");
          Object.defineProperty(event, "key", { value: key });
          if (target !== undefined) {
            Object.defineProperty(event, "target", { value: target });
          }
          globalThis.dispatchEvent(event);
        };

        it("moves the selection with the left and right arrow keys", () => {
          const view = connected(3);
          const announced = view.dispatched("step-selected");

          press("ArrowRight");
          press("ArrowRight");
          press("ArrowLeft");
          press("Enter");

          expect(view.selected).toBe(1);
          expect(announced).toEqual([1, 2, 1]);
        });

        it("leaves an arrow key pressed in an editable element to that element", () => {
          const view = connected(3);

          press("ArrowRight", { tagName: "INPUT" });
          press("ArrowRight", { tagName: "TEXTAREA" });
          press("ArrowRight", { tagName: "DIV", isContentEditable: true });
          expect(view.selected).toBe(0);

          press("ArrowRight", { tagName: "DIV" });
          expect(view.selected).toBe(1);
        });

        it("announces nothing for a run with no steps", () => {
          const view = connected(0);
          const announced = view.dispatched("step-selected");

          press("ArrowRight");

          expect(announced).toEqual([]);
          expect(view.selected).toBe(0);
        });

        it("stops answering the arrow keys once the view leaves the page", () => {
          const view = connected(3);

          view.disconnectedCallback();
          press("ArrowRight");

          expect(view.selected).toBe(0);
        });
      });
    });

    describe("rail", () => {
      it("marks the steps that minted handles, and the ones that let a wide run of numbers across", () => {
        const text = shown(showing([
          toolStep(0, {
            handlesIntroduced: ["cfh:a:abcde", "cfh:a:bcdef"],
            disclosure: {
              valueBytes: 400,
              sealedPositions: 0,
              longestNumericRun: 40,
            },
          }),
          toolStep(1, {
            disclosure: {
              valueBytes: 40,
              sealedPositions: 0,
              longestNumericRun: 31,
            },
          }),
          { ...toolStep(2), kind: "assistant", toolName: undefined },
          toolStep(3, { toolName: undefined }),
        ]));

        expect(text).toContain('<span class="step-mint"> +2 </span>');
        expect(text.match(/step-mint/g)).toHaveLength(1);
        expect(text.match(/class="step-warn"/g)).toHaveLength(1);
        expect(text).toContain('<span class="step-name">assistant</span>');
        expect(text).toContain('<span class="step-name">tool</span>');
      });
    });

    describe("step detail", () => {
      it("renders a prose step's text, and an empty body for one with none", () => {
        const view = showing([
          { ...toolStep(0), kind: "user", text: "Order donuts" },
          { ...toolStep(1), kind: "system" },
        ]);

        expect(shown(view)).toContain(
          '<div class="pane-head">user</div> <div class="body">Order donuts</div>',
        );
        view.selected = 1;
        expect(shown(view)).toContain(
          '<div class="pane-head">system</div> <div class="body"></div>',
        );
      });

      it("renders the handles in scope, the ones the step introduced first", () => {
        const handle = (
          token: string,
          introducedAtStep: number,
          ref?: string,
        ): ConsoleHandle => ({
          token,
          introducedAtStep,
          uses: [],
          confidentiality: [],
          ...(ref === undefined ? {} : { ref }),
        });
        const older = handle("cfh:a:abcde", 0, "of:older");
        const fresh = handle("cfh:a:bcdef", 1);
        const elsewhere = handle("cfh:a:cdefg", 0);
        const view = showing([
          toolStep(0),
          toolStep(1, {
            handlesIntroduced: [fresh.token],
            handlesInScope: [older.token, fresh.token],
          }),
        ], [older, fresh, elsewhere]);

        expect(shown(view)).toContain("None yet.");
        view.selected = 1;
        const text = shown(view);

        expect(text).toContain("handles in scope (2)");
        expect(text).not.toContain("None yet.");
        expect(text.indexOf('class="fresh"')).toBeLessThan(
          text.indexOf("of:older"),
        );
        expect(text).toMatch(/class="fresh"[^]*?—[^]*?new here/);
        expect(text).toMatch(/of:older[^]*?step 0/);
        expect(
          templateBindings(view.view())
            .filter((binding) => binding.name === ".cell")
            .map((binding) => binding.value),
        ).toEqual([fresh, older]);
      });

      it("renders a literal argument with its atoms, and a reference as a chip leading to its step", () => {
        const produced: ConsoleHandle = {
          token: "cfh:a:abcde",
          ref: "of:orders",
          introducedAtStep: 0,
          producedByStep: 0,
          uses: [],
          confidentiality: [],
        };
        const view = showing([
          toolStep(0),
          toolStep(1, {
            input: { path: "orders.json", orders: "cfh:a:abcde" },
            invocation: {
              type: "cf-harness.cfc-invocation-context",
              version: 1,
              sequence: 1,
              runId: "r",
              createdAt: "2026-01-01T00:00:00.000Z",
              toolId: "read_file",
              operation: "command",
              cfcEnforcementMode: "observe",
              cwd: "/workspace",
              runManifest: { present: false },
              inputs: {},
              cfcInputLabels: {
                version: 1,
                entries: [{
                  path: ["path"],
                  label: { confidentiality: [{ type: "Secret" }] },
                }],
              },
              promptSlotInfluenceLabels: {
                version: 1,
                entries: [{
                  path: ["path"],
                  label: { integrity: [{ type: "PromptSlotInfluence" }] },
                }],
              },
            },
          }),
        ], [produced]);
        view.selected = 1;
        const announced = view.dispatched("step-selected");

        const text = shown(view);
        expect(text).toContain('<span class="badge ok"> 1 reference </span>');
        expect(text).toContain(
          '<span class="arg-key">path</span> <span class="arg-value"> "orders.json" </span>',
        );
        expect(text).toContain('<span class="atom conf">Secret</span>');
        expect(text).toContain(
          '<span class="atom integ">PromptSlotInfluence</span>',
        );
        expect(bindingOn(view.view(), ".cell", "", "console-cell")).toEqual(
          expect.objectContaining({ token: "cfh:a:abcde", ref: "of:orders" }),
        );

        handlerOn(view.view(), "@click", "← step 0")();
        expect(view.selected).toBe(0);
        expect(announced).toEqual([0]);
      });

      it("says a reference no step of this run produced came from an earlier turn", () => {
        const text = shown(showing([toolStep(0, {
          input: { a: "cfh:a:abcde", b: "cfh:a:bcdef" },
        })]));

        expect(text).toContain('<span class="badge ok"> 2 references </span>');
        expect(text.match(/from an earlier turn/g)).toHaveLength(2);
        expect(text).not.toContain("← step");
      });

      it("counts no references for a call given only values, and draws no argument pane for one given nothing", () => {
        expect(shown(showing([toolStep(0, { input: { n: 1 } })]))).toContain(
          '<span class="badge none"> 0 references </span>',
        );
        expect(shown(showing([toolStep(0)]))).not.toContain(
          "arguments",
        );
      });

      it("states what a result let across as value, warning only of a wide numeric run", () => {
        const narrow = shown(showing([toolStep(0, {
          disclosure: {
            valueBytes: 12,
            sealedPositions: 2,
            longestNumericRun: 0,
          },
        })]));
        const wide = shown(showing([toolStep(0, {
          disclosure: {
            valueBytes: 400,
            sealedPositions: 0,
            longestNumericRun: 40,
          },
        })]));

        expect(narrow).toContain(
          '<span class="badge ok"> 12 B as value </span>',
        );
        expect(narrow).toContain("2 sealed behind a reference </span>");
        expect(narrow).not.toContain("longest numeric run");
        expect(narrow).not.toContain("numbers crossed as value");
        expect(wide).toContain(
          '<span class="badge warn"> 400 B as value </span>',
        );
        expect(wide).toContain("A run of 40 numbers crossed as value.");
        expect(shown(showing([toolStep(0)]))).not.toContain("disclosure");
      });

      it("renders a call's input and output as text where they did not parse, and a dash where they are absent", () => {
        const text = shown(showing([toolStep(0, {
          inputText: "not json in",
          outputText: "not json out",
        })]));
        const absent = shown(showing([toolStep(0)]));

        expect(text).toContain('<pre class="raw">not json in</pre>');
        expect(text).toContain('<pre class="raw">not json out</pre>');
        expect(absent.match(/<pre class="raw">—<\/pre>/g)).toHaveLength(2);
        expect(absent).not.toContain("Open subagent run");
        expect(absent).not.toContain("Source replaced");
      });

      it("asks the page to open the subagent run a call started", () => {
        const view = showing([toolStep(0, { childRunId: "run.subagent.1" })]);
        const opened = view.dispatched("open-run");

        handlerOn(view.view(), "@click", "Open subagent run")();

        expect(opened).toEqual(["run.subagent.1"]);
      });
    });

    it("renders a step's reasoning as plain text in a thinking pane, for prose and for a call", () => {
      const steps = consoleRunSteps([
        {
          role: "assistant",
          content: "",
          reasoning: "**Read** [it](https://elsewhere.example/) first.",
          toolCalls: [{
            id: "c1",
            type: "function" as const,
            function: { name: "read_file", arguments: '{"path":"a"}' },
          }],
        },
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "read_file",
          content: JSON.stringify({ outputId: "o1", content: "a" }),
        },
        { role: "assistant", content: "done", reasoning: "It says *done*." },
      ]);
      const view = new TestConsoleSteps();
      view.steps = steps;
      const shown = [0, 1].map((selected) => {
        view.selected = selected;
        return templateText(view.view());
      });

      expect(shown[0]).toContain('<div class="pane-head">thinking</div>');
      expect(shown[0]).toContain(
        "**Read** [it](https://elsewhere.example/) first.",
      );
      expect(shown[0]).not.toContain("<a");
      expect(shown[1]).toContain("It says *done*.");
      expect(shown[1]).not.toContain("<em>");
    });

    it("renders the model-facing result beside its retrospective context", () => {
      const outputId = createToolOutputId("run", "run_pattern", 1);
      const token = "cfh:a:abcde";
      const handle: ConsoleHandle = {
        token,
        ref: "/of:fid1:cell",
        introducedAtStep: 0,
        producedByStep: 0,
        uses: [],
        confidentiality: [],
      };
      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "run_pattern",
        toolCallId: "call-1",
        input: { sourceText: "marker", input: token, count: 2 },
        sourceReplacedByLaterAttempt: true,
        output: { status: "ok", value: 4 },
        resultRef: {
          type: "cf-harness.tool-result-ref",
          outputId,
          toolId: "run_pattern",
          runId: "run",
        },
        childRunId: "run.subagent.1",
        handlesIntroduced: [token],
        handlesInScope: [token],
        status: "ok",
        policy: {
          decision: "allowed",
          effectClass: "side-effect",
          reasonCodes: ["direct-command"],
        },
        policyEvents: [{
          type: "cf-harness.policy-event",
          severity: "warning",
          mode: "observe",
          toolId: "run_pattern",
          toolCallId: "call-1",
          detail: "observed",
          at: "2026-01-01T00:00:00.000Z",
        }],
        disclosure: {
          valueBytes: 1_024,
          sealedPositions: 1,
          longestNumericRun: 32,
        },
        withheld: {
          status: "recorded",
          locations: [{
            rule: "artifact-only",
            artifactPath: "/run/output.json",
            jsonPointer: "/rawValue",
            value: "retained",
            available: true,
          }],
        },
        invocation: {
          type: "cf-harness.cfc-invocation-context",
          version: 1,
          sequence: 1,
          runId: "run",
          createdAt: "2026-01-01T00:00:00.000Z",
          toolId: "run_pattern",
          toolOutputId: outputId,
          operation: "command",
          cfcEnforcementMode: "observe",
          cwd: "/workspace",
          runManifest: { present: false },
          inputs: {},
          cfcInputLabels: {
            version: 1,
            entries: [{
              path: ["count"],
              label: {
                confidentiality: [{ type: "Secret" }],
                integrity: [{ type: "Trusted" }],
              },
            }],
          },
        },
      };
      const view = new TestConsoleSteps();
      view.steps = [step];
      view.handles = [handle];

      const text = templateText(view.view());
      expect(text).toContain("Source replaced by a later attempt");
      expect(text).toContain("run-pattern-source sidecar");
      expect(text).toContain("retained");
      expect(text).toContain(
        'Model received: {\n  "status": "ok",\n  "value": 4\n}',
      );
      expect(text).not.toContain("withheld by policy");
      expect(text).toContain("longest numeric run 32");
      expect(text).toContain("Open subagent run");
    });

    it("marks a legacy trace's withheld release, whose persisted word is `denied`", () => {
      // The whole path, from the record on disk to the badge: a run recorded
      // before the outcome existed persisted `denied` beside a release that
      // held values back, and the view must still show the boundary rather
      // than a denial of a call that ran.
      const steps = consoleRunSteps(
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{
              id: "c1",
              type: "function",
              function: { name: "run_pattern", arguments: "{}" },
            }],
          },
          {
            role: "tool",
            toolCallId: "c1",
            toolName: "run_pattern",
            content: JSON.stringify({ status: "ok" }),
          },
        ],
        [{
          type: "cf-harness.policy-decision",
          sequence: 1,
          runId: "run-legacy",
          at: "2026-01-01T00:00:00.000Z",
          toolActivitySequence: 1,
          toolCallId: "c1",
          toolId: "run_pattern",
          cfcEnforcementMode: "enforce-explicit",
          decision: "denied",
          reasonCodes: ["cfc_release_withheld"],
          release: {
            reasonCode: "cfc_release_withheld",
            boundary: "release",
            sink: "run_pattern",
            ceiling: [],
          },
        }],
      );
      const view = new TestConsoleSteps();
      view.steps = steps;

      const text = templateText(view.view());
      expect(steps[0].status).toBe("ok");
      expect(text).toContain("withheld");
      expect(text).not.toContain("denied");
    });

    it("marks a withheld release beside the CFC line of a step that succeeded", () => {
      // The CFC line names the refused release separately from the artifact
      // omission, while the model-facing result still records success.

      const step: ConsoleStep = {
        index: 0,
        kind: "tool",
        toolName: "run_pattern",
        toolCallId: "call-1",
        output: { status: "ok" },
        handlesIntroduced: [],
        handlesInScope: [],
        status: "ok",
        policy: {
          decision: "withheld",
          effectClass: "side-effect",
          reasonCodes: ["cfc_release_withheld"],
        },
        policyEvents: [],
        withheld: {
          status: "recorded",
          locations: [{
            rule: "artifact-only",
            artifactPath: "/run/output.json",
            jsonPointer: "/value",
            value: "retained",
            available: true,
          }],
        },
      };
      const view = new TestConsoleSteps();
      view.steps = [step];

      const text = templateText(view.view());
      expect(text).toContain("withheld by policy");
      expect(text).toContain("kept on the artifact, not sent to the model · 1");
      expect(text).toContain('Model received: {\n  "status": "ok"\n}');
      expect(text).not.toContain("denied");
    });
  });
});
