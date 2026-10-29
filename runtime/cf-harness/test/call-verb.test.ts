/**
 * `call_verb` sends an event to a verb of a piece the run holds, and
 * `describe_handle` is where the run learns which verbs that piece has and
 * what each takes and returns. Together they are what lets an agent drive a
 * piece it holds rather than only read it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { HarnessFabricSessionConfig } from "../src/config.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessToolTranscriptMessage,
} from "../src/contracts/transcript.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import type { HarnessInputCell } from "../src/contracts/input-cells.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { callVerbTool } from "../src/tools/call-verb.ts";
import { describeHandleTool } from "../src/tools/describe-handle.ts";
import {
  runPatternTool,
  type RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase("cf-harness call-verb");

/**
 * A timer whose state changes only through its verbs. `start` takes fields
 * and hands back a result, `stop` takes nothing, and `status` is data rather
 * than a verb, which is what the refusals below need to tell apart.
 */
const TIMER_PATTERN_SOURCE = [
  "import { action, computed, Default, NAME, pattern, Stream, Writable } from 'commonfabric';",
  "interface StartEvent {",
  "  /** How long the timer runs, in whole minutes. */",
  "  minutes: number;",
  "  label?: string;",
  "}",
  "interface StartResult { endsAt: number; label: string; }",
  "interface Input {",
  "  minutes?: Writable<number | Default<25>>;",
  "  label?: Writable<string | Default<''>>;",
  "  status?: Writable<string | Default<'idle'>>;",
  "}",
  "interface Output {",
  "  $NAME: string;",
  "  minutes: number;",
  "  label: string;",
  "  status: string;",
  "  /** Start the timer. */",
  "  start: Stream<StartEvent, StartResult>;",
  "  stop: Stream<void>;",
  "}",
  "export default pattern<Input, Output>(({ minutes, label, status }) => {",
  "  const start = action<StartEvent, StartResult>((event) => {",
  "    if (!(event.minutes > 0)) throw new Error('start: minutes must be positive');",
  "    minutes.set(event.minutes);",
  "    label.set(event.label ?? '');",
  "    status.set('running');",
  "    return { endsAt: event.minutes * 60000, label: event.label ?? '' };",
  "  });",
  "  const stop = action(() => { status.set('stopped'); });",
  "  return {",
  "    [NAME]: computed(() => `Timer: ${status.get()}`),",
  "    minutes, label, status, start, stop,",
  "  };",
  "});",
  "",
].join("\n");

/** The context members the two tools read, and no others. */
const contextWith = (
  session: HarnessFabricSession,
  table?: ReturnType<typeof createHarnessHandleTable>,
  inputCells?: readonly HarnessInputCell[],
): HarnessToolContext =>
  ({
    runId: "run-call-verb",
    cfcEnforcementMode: "disabled",
    ...(table !== undefined ? { handleTable: table } : {}),
    ...(inputCells !== undefined ? { inputCells } : {}),
    getFabricSession: () => Promise.resolve(session),
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-call-verb", toolId, 1),
  }) as unknown as HarnessToolContext;

describe("call-verb", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let session: HarnessFabricSession;
  let neighbour: PiecesController;

  /** The run's handle table: what a model holding these handles holds. */
  let held: HarnessHandleTable;

  /** Records `ref` in {@link held}, as the outbound swap does when a tool
   * hands a model the address, and returns it. */
  const hold = async (ref: string): Promise<string> => {
    held = (await mintAddressHandle(held, ref)).table;
    return ref;
  };

  beforeEach(async () => {
    held = createHarnessHandleTable("run-call-verb");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
    session = { pieces };
    neighbour = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await neighbour.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Runs the timer and returns the reference to its result cell. */
  const createTimer = async (): Promise<string> => {
    const output = await runPatternTool.invoke(
      contextWith(session),
      { sourceText: TIMER_PATTERN_SOURCE },
    ) as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    return await hold(output.resultRef);
  };

  /** One field of the piece at `ref`, read back through the runtime. */
  const readField = async (ref: string, field: string): Promise<unknown> => {
    const cell = runtime.getCellFromLink(
      parseLLMFriendlyLink(ref, session.pieces.getSpace()),
    ) as Cell<Record<string, unknown>>;
    return await cell.key(field).pull();
  };

  describe("describe_handle on a piece", () => {
    it("lists each verb with the event it takes and the result it returns", async () => {
      // The listing is the call signature: without the event's fields an
      // agent cannot write a call, and without the result it cannot plan on
      // what comes back. `status` is data and is not listed.
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        ref,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      expect(output.verbs?.map((verb) => verb.name)).toEqual([
        "start",
        "stop",
      ]);
      const start = output.verbs!.find((verb) => verb.name === "start")!;
      expect(start.inputSchema).toMatchObject({
        type: "object",
        properties: {
          minutes: { type: "number" },
          label: { type: "string" },
        },
        required: ["minutes"],
      });
      expect(start.outputSchema).toMatchObject({
        type: "object",
        properties: {
          endsAt: { type: "number" },
          label: { type: "string" },
        },
        required: ["endsAt", "label"],
      });
    });

    it("reports each verb's doc comment and its event fields' descriptions", async () => {
      // A model cannot call a verb well without its author's account of it,
      // so a verb's signature crosses with its prose where every other schema
      // this tool discloses is reduced to structure.
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        ref,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      const start = output.verbs!.find((verb) => verb.name === "start")!;
      expect(start.description).toBe("Start the timer.");
      expect(JSON.stringify(start.inputSchema)).toContain(
        "How long the timer runs, in whole minutes.",
      );
    });

    it("lists no verbs for a field within a piece", async () => {
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        `${ref}/status`,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      expect(output.verbs).toBeUndefined();
    });
  });

  describe("call_verb", () => {
    it("runs the verb's handler and returns its declared result", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 10 },
      });

      expect(output).toMatchObject({
        status: "ok",
        verb: "start",
        result: { endsAt: 600000 },
      });
      expect(await readField(ref, "status")).toBe("running");
      expect(await readField(ref, "minutes")).toBe(10);
    });

    it("returns a piece the verb returns inside a union result as that piece's handle", async () => {
      // The declared result is a union, so the reference sits under one of
      // its branches rather than under the result's own properties.
      const source = [
        "import { action, Default, pattern, Stream, Writable } from 'commonfabric';",
        "interface ItemOutput { title: string; }",
        "const Item = pattern<{ title: string }, ItemOutput>(({ title }) => ({ title }));",
        "type AddResult = { absent: true } | { item: ItemOutput };",
        "interface Board { items: ItemOutput[]; addItem: Stream<{ title: string }, AddResult>; }",
        "export default pattern<{ items?: Writable<ItemOutput[] | Default<[]>> }, Board>(({ items }) => {",
        "  const addItem = action<{ title: string }, AddResult>((event) => {",
        "    const item = Item({ title: event.title });",
        "    items.push(item);",
        "    return { item };",
        "  });",
        "  return { items, addItem };",
        "});",
        "",
      ].join("\n");
      const board = (await runPatternTool.invoke(contextWith(session), {
        sourceText: source,
      }) as RunPatternToolSuccessOutput).resultRef;
      await hold(board);

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: board,
        verb: "addItem",
        event: { title: "Ship" },
      });

      expect(output).toMatchObject({
        status: "ok",
        result: { item: { "@link": expect.any(String) } },
      });
    });

    it("returns a string the result carries as a reference rather than as text", async () => {
      // A string is free text, which the release boundary withholds unless a
      // schema bounds it; the reference addresses the position instead, so a
      // later step can still wire it onward.
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 10, label: "deep work" },
      });

      expect(output.status).toBe("ok");
      expect(JSON.stringify(output)).not.toContain("deep work");
      const result = (output as { result: { label: unknown } }).result;
      expect(result.label).toEqual({ "@link": expect.any(String) });
    });

    it("returns the message a failing handler threw", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 0 },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "start: minutes must be positive",
      );
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("runs a verb that takes no event", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "stop",
      });

      expect(output).toMatchObject({ status: "ok", verb: "stop" });
      expect(await readField(ref, "status")).toBe("stopped");
    });

    it("refuses a field the verb does not declare, before the event is sent", async () => {
      // `minutes` alone would start the timer, so a status still `idle`
      // afterwards is what shows nothing was dispatched.
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 10, colour: "red" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain('"colour"');
      expect(await readField(ref, "status")).toBe("idle");
      expect(await readField(ref, "minutes")).toBe(25);
    });

    it("refuses an event missing a required field, before the event is sent", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { label: "deep work" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain("minutes");
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("refuses a property that is not a verb and names the verbs there are", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "status",
        event: "running",
      });

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain('"status" is not a verb');
      expect(message).toContain('"start"');
      expect(message).toContain('"stop"');
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("refuses a piece the run holds no handle to, without repeating its address", async () => {
      // A model that writes an address out in full reaches nothing it was not
      // handed; and the refusal names no address the outbound swap could mint
      // a handle for.
      const ref = await createTimer();
      held = createHarnessHandleTable("run-call-verb");

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 10 },
      });

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain("behind a handle this run holds");
      expect(message).not.toContain(ref.slice(1));
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("refuses a piece in a space other than the run's own", async () => {
      // The run may describe a piece in an admitted foreign space, which is a
      // read; sending it an event is a write, which reaches the run's own
      // space only.
      const foreign = await neighbour.create(TIMER_PATTERN_SOURCE, {
        input: {},
      });
      const ref = await hold(
        `//${neighbour.getSpace()}/${foreign.getCell().getAsNormalizedFullLink().id}`,
      );

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: ref,
        verb: "start",
        event: { minutes: 10 },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "this run's own space",
      );
    });
  });

  describe("with a piece in another space", () => {
    /** The session as a job handed a piece in the neighbour space has it:
     * that space admitted, on the session's own host. */
    let admitted: HarnessFabricSession;

    /** A timer in the neighbour space, held as a handle, and the token. */
    const foreignTimer = async (): Promise<{ ref: string; token: string }> => {
      const created = await neighbour.create(TIMER_PATTERN_SOURCE, {
        input: {},
      });
      const ref =
        `//${neighbour.getSpace()}/${created.getCell().getAsNormalizedFullLink().id}`;
      const minted = await mintAddressHandle(held, ref);
      held = minted.table;
      return { ref, token: minted.token };
    };

    beforeEach(() => {
      admitted = {
        ...session,
        foreignSpaces: { [neighbour.getSpace()]: "http://toolshed.test/" },
      };
    });

    it("describes and calls a verb of a piece the run was handed in another space", async () => {
      // An input names the piece in its own space, and the space is admitted
      // for the run: the piece is described there and its verb runs there.
      const timer = await foreignTimer();
      const inputs = [{ name: "timer", ...timer }];

      const described = await describeHandleTool.invoke(
        contextWith(admitted, held, inputs),
        { token: timer.token },
      );
      const output = await callVerbTool.invoke(
        contextWith(admitted, held, inputs),
        { token: timer.ref, verb: "start", event: { minutes: 10 } },
      );

      expect(described.verbs?.map((verb) => verb.name)).toEqual([
        "start",
        "stop",
      ]);
      expect(output).toMatchObject({ status: "ok", verb: "start" });
      expect(await readField(timer.ref, "status")).toBe("running");
    });

    it("names the denial when the run cannot read a handed piece's space", async () => {
      // A space this run may not read serves its documents as empty, which
      // reads exactly like a piece with no schema and no verbs; the denial is
      // what the model needs instead, or it builds a replacement.
      const timer = await foreignTimer();
      const inputs = [{ name: "timer", ...timer }];
      const denied =
        `Principal did:key:z6MkTest lacks READ on space ${neighbour.getSpace()}`;
      const manager = runtime.storageManager as unknown as {
        authorizationError?: (space: string) => Error | undefined;
      };
      manager.authorizationError = (space) =>
        space === neighbour.getSpace() ? new Error(denied) : undefined;

      const described = await describeHandleTool.invoke(
        contextWith(admitted, held, inputs),
        { token: timer.token },
      );
      const called = await callVerbTool.invoke(
        contextWith(admitted, held, inputs),
        { token: timer.ref, verb: "start", event: { minutes: 10 } },
      );

      expect(described.error).toContain("lacks READ");
      expect(described.hasSchema).toBe(false);
      expect(called.status).toBe("error");
      expect((called as { message: string }).message).toContain("lacks READ");
    });

    it("calls a verb of a piece the run reached in another space without being handed it", async () => {
      // Anything the run reaches through the pieces it was given is in its
      // scope, so a piece found beside a handed one is as callable as it.
      const handed = await foreignTimer();
      const other = await foreignTimer();

      const output = await callVerbTool.invoke(
        contextWith(admitted, held, [{ name: "timer", ...handed }]),
        { token: other.ref, verb: "start", event: { minutes: 10 } },
      );

      expect(output).toMatchObject({ status: "ok", verb: "start" });
      expect(await readField(other.ref, "status")).toBe("running");
    });
  });

  describe("with a reference argument", () => {
    /** The tracker the CLI's verb session drives, whose `blockOn` takes an
     * item by reference. */
    const trackerSource = () =>
      Deno.readTextFile(
        new URL(
          "../../cli/integration/pattern/tracker.tsx",
          import.meta.url,
        ),
      );

    /** Files a root item on `board` and returns the address `addItem` handed
     * back for it, which is where a run gets an item's handle from. */
    const fileItem = async (board: string, title: string): Promise<string> => {
      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: board,
        verb: "addItem",
        event: { title },
      });
      expect(output.status).toBe("ok");
      const item = (output as { result: { item: { "@link": string } } })
        .result.item;
      expect(item).toEqual({ "@link": expect.any(String) });
      return await hold(item["@link"]);
    };

    /** The ids the stored `blockedOn` list of the item at `ref` links to. */
    const blockedOnIds = async (ref: string): Promise<unknown[]> => {
      const cell = runtime.getCellFromLink(
        parseLLMFriendlyLink(ref, session.pieces.getSpace()),
      ) as Cell<Record<string, unknown>>;
      await cell.key("blockedOn").pull();
      const raw = cell.key("blockedOn").resolveAsCell().getRaw() as
        | unknown[]
        | undefined;
      return (raw ?? []).map((entry) =>
        (entry as { "/": { "link@1": { id: string } } })["/"]["link@1"].id
      );
    };

    let board: string;

    beforeEach(async () => {
      const output = await runPatternTool.invoke(
        contextWith(session),
        { sourceText: await trackerSource() },
      ) as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      board = await hold(output.resultRef);
    });

    it("refuses an inline copy at a reference position, before the event is sent", async () => {
      // A copy of the target's fields matches its shape, so only the declared
      // contract can tell it from a reference: stored, it would be a detached
      // document rather than an edge.
      const item = await fileItem(board, "Ship");

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: item,
        verb: "blockOn",
        event: { on: { title: "Review" } },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "inline copy",
      );
      expect(await blockedOnIds(item)).toEqual([]);
    });

    it("refuses a string that is not an address at a reference position", async () => {
      const item = await fileItem(board, "Ship");

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: item,
        verb: "blockOn",
        event: { on: "Review" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "is not an address",
      );
      expect(await blockedOnIds(item)).toEqual([]);
    });

    it("refuses an address at a reference position the run holds no handle to", async () => {
      const item = await fileItem(board, "Ship");
      const unheldItem = (await callVerbTool.invoke(
        contextWith(session, held),
        { token: board, verb: "addItem", event: { title: "Review" } },
      ) as { result: { item: { "@link": string } } }).result.item["@link"];

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: item,
        verb: "blockOn",
        event: { on: unheldItem },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "<event>.on names a piece this run holds no handle to",
      );
      expect(await blockedOnIds(item)).toEqual([]);
    });

    it("refuses a link written out in full in the event", async () => {
      const item = await fileItem(board, "Ship");
      const other = await fileItem(board, "Review");
      const id = parseLLMFriendlyLink(other, session.pieces.getSpace()).id;

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: item,
        verb: "blockOn",
        event: { on: { "/": { "link@1": { id } } } },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "link written out in full",
      );
      expect(await blockedOnIds(item)).toEqual([]);
    });

    it("refuses a handle token the run does not hold", async () => {
      // A token the table holds reaches the tool as its address; one it does
      // not hold arrives as written.
      const item = await fileItem(board, "Ship");

      const output = await callVerbTool.invoke(contextWith(session, held), {
        token: item,
        verb: "blockOn",
        event: { on: "cfh:a:zzzzz" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "cfh:a:zzzzz at <event>.on is not a handle this run holds",
      );
      expect(await blockedOnIds(item)).toEqual([]);
    });
  });

  describe("at the prompt-loop model boundary", () => {
    /**
     * Runs a scripted model through the ordinary tool dispatcher. Each step
     * receives the previous tool's parsed output and returns the next call;
     * the run ends after the last one.
     */
    const runScripted = async (
      steps: readonly ((
        previous: Record<string, unknown>,
      ) =>
        | { name: string; input: unknown }
        | Promise<{ name: string; input: unknown }>)[],
    ) => {
      const artifactRoot = await Deno.makeTempDir();
      const outputs: Record<string, unknown>[] = [];
      const toolOutput = (request: HarnessModelTurnRequest) =>
        JSON.parse(
          (request.transcript.findLast((message) => message.role === "tool") as
            | HarnessToolTranscriptMessage
            | undefined)?.content ?? "{}",
        );
      try {
        let turn = 0;
        const loop = new CfHarnessPromptLoop({
          sandboxRuntime: {
            describe: () => ({
              kind: "runsc-cfc",
              defaultWorkingDirectory: "/workspace",
              cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
            }),
            defaultWorkingDirectory: () => "/workspace",
            resolvePath: (path) => path,
            isPathWithinWorkspace: () => true,
            isPathWithinAllowedRoots: () => true,
            run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            runShell: () =>
              Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          } satisfies SandboxRuntime,
          artifactRoot,
          runId: "run-call-verb-loop",
          model: "test-model",
          fabricSession: {
            apiUrl: "http://toolshed.test",
            identityKeyPath: "/unused/fixture.key",
            space: session.pieces.getSpace(),
          } satisfies HarnessFabricSessionConfig,
          fabricSessionFactory: () => Promise.resolve(session),
          allowedToolIds: ["run_pattern", "describe_handle", "call_verb"],
          modelClient: {
            providerId: "test-provider",
            complete: async (request) => {
              const previous = toolOutput(request);
              if (turn > 0) outputs.push(previous);
              const step = steps[turn];
              turn += 1;
              if (step === undefined) {
                return { assistant: { role: "assistant", content: "Done." } };
              }
              const { name, input } = await step(previous);
              const assistant: HarnessAssistantTranscriptMessage = {
                role: "assistant",
                content: "",
                toolCalls: [{
                  id: `call-${turn}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(input) },
                }],
              };
              return { assistant };
            },
          },
        });
        const result = await loop.runPrompt({
          prompt: "drive the piece",
          maxModelTurns: steps.length + 1,
          promptSlotBinding: directPromptSlotBindingFor("call-verb"),
        });
        return { outputs, result };
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    };

    it("lets a model holding a piece's handle read its verbs and call one", async () => {
      // The model never sees an address: it holds the token run_pattern
      // handed back, describes it to learn the verbs, and calls one by the
      // same token.
      let token = "";
      const { outputs, result } = await runScripted([
        () => ({
          name: "run_pattern",
          input: { sourceText: TIMER_PATTERN_SOURCE },
        }),
        (ran) => {
          token = ran.resultRef as string;
          return { name: "describe_handle", input: { token } };
        },
        () => ({
          name: "call_verb",
          input: { token, verb: "start", event: { minutes: 10 } },
        }),
      ]);

      expect(token).toMatch(/^cfh:a:/);
      expect(
        (outputs[1].verbs as { name: string }[]).map((verb) => verb.name),
      ).toEqual(["start", "stop"]);
      expect(outputs[2]).toMatchObject({
        status: "ok",
        verb: "start",
        result: { endsAt: 600000 },
      });
      const entry = resolveHandleToken(result.runState.handleTable!, token);
      expect(await readField(entry!.ref, "status")).toBe("running");
    });

    it("passes an item's handle to a verb that takes the item by reference", async () => {
      // addItem hands each item back as a handle, and blockOn takes one: the
      // token reaches the verb as the item's address and is stored as a link
      // to it, never as a copy of it.
      const tokens: string[] = [];
      const itemToken = (output: Record<string, unknown>) =>
        (output.result as { item: string }).item;
      const { outputs, result } = await runScripted([
        async () => ({
          name: "run_pattern",
          input: {
            sourceText: await Deno.readTextFile(
              new URL(
                "../../cli/integration/pattern/tracker.tsx",
                import.meta.url,
              ),
            ),
          },
        }),
        (ran) => {
          tokens.push(ran.resultRef as string);
          return {
            name: "call_verb",
            input: {
              token: tokens[0],
              verb: "addItem",
              event: { title: "Ship" },
            },
          };
        },
        (filed) => {
          tokens.push(itemToken(filed));
          return {
            name: "call_verb",
            input: {
              token: tokens[0],
              verb: "addItem",
              event: { title: "Review" },
            },
          };
        },
        (filed) => {
          tokens.push(itemToken(filed));
          return {
            name: "call_verb",
            input: {
              token: tokens[1],
              verb: "blockOn",
              event: { on: tokens[2] },
            },
          };
        },
      ]);

      expect(tokens.slice(1)).toEqual([
        expect.stringMatching(/^cfh:a:/),
        expect.stringMatching(/^cfh:a:/),
      ]);
      expect(outputs.at(-1)).toMatchObject({ status: "ok", verb: "blockOn" });
      const table = result.runState.handleTable!;
      const ship = resolveHandleToken(table, tokens[1])!.ref;
      const review = resolveHandleToken(table, tokens[2])!.ref;
      const cell = runtime.getCellFromLink(
        parseLLMFriendlyLink(ship, session.pieces.getSpace()),
      ) as Cell<Record<string, unknown>>;
      await cell.key("blockedOn").pull();
      const stored = cell.key("blockedOn").resolveAsCell().getRaw() as {
        "/": { "link@1": { id: string } };
      }[];
      expect(stored.map((entry) => entry["/"]["link@1"].id)).toEqual([
        parseLLMFriendlyLink(review, session.pieces.getSpace()).id,
      ]);
    });
  });
});
