import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import type { FabricPlainObject } from "@commonfabric/api";

import {
  bodyAction,
  commentAction,
  findTopic,
  linkAction,
  main,
  mentionAction,
  newAction,
  type ProgramRun,
  runProgram,
  searchAction,
  showAction,
  stdinText,
  syncAction,
  titleAction,
  type TopicsDeps,
  USAGE,
  writeSession,
} from "./topics.ts";
import type { Topic } from "./mirror.ts";
import {
  BOARD,
  type BoardServer,
  boardServer,
  INPUT_1,
  link,
  SPACE,
} from "./board-fixture.ts";

/** A verb call the fake dispatch received. */
interface Call {
  piece: string;
  verb: string;
  payload: Record<string, string>;
  invocation: string;
  session: string;
  args: readonly string[];
}

/** A comment's time on the second day the board's comments span. */
const DAY_TWO = Date.UTC(2026, 9, 27, 12);

/** How far a failing `cf piece call` got before it failed. */
type Phase = "initial_sync" | "dispatched" | "committed";

describe("topics command", () => {
  let board: BoardServer;
  let dir: string;
  let output: string[];
  let warnings: string[];
  let calls: Call[];
  let stepped: string[];
  let stdin: string | undefined;
  let input: FabricPlainObject;
  let applyWrites: boolean;
  let status: string;
  let failure: { phase: Phase | undefined; error: Error } | undefined;
  let garbled: boolean;
  let stepFails: boolean;

  beforeEach(async () => {
    board = await boardServer();
    dir = await Deno.makeTempDir({ prefix: "topics-tool-command-" });
    output = [];
    warnings = [];
    calls = [];
    stepped = [];
    stdin = undefined;
    input = { ...INPUT_1 };
    applyWrites = true;
    status = "settled";
    failure = undefined;
    garbled = false;
    stepFails = false;
  });

  afterEach(async () => {
    await board.close();
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * Performs `verb` on the board the way the Topics pattern does, for the
   * documents these tests read back. A repeated invocation id settles on the
   * first outcome without writing.
   */
  async function dispatch(
    piece: string,
    verb: string,
    payload: Record<string, string>,
  ): Promise<unknown> {
    const by = { kind: "agent", name: payload.agentName };
    const writeInput = (value: FabricPlainObject) => {
      input = value;
      return board.write({ "of:fid1:input-1": { value } });
    };
    const list = (key: string) => {
      const value = input[key];
      return Array.isArray(value) ? value : [];
    };
    if (!applyWrites) return undefined;
    if (verb === "addTopic") {
      await board.write({
        "of:fid1:topic-piece-3": {
          value: {},
          argument: link("of:fid1:input-3"),
        },
        "of:fid1:input-3": {
          value: { title: payload.title, body: payload.body, createdBy: by },
        },
        "of:fid1:board-input": {
          value: {
            names: {
              "1": link("of:fid1:topic-alias-1"),
              "2": link("of:fid1:topic-piece-2"),
              "3": link("of:fid1:topic-piece-3"),
            },
          },
        },
      });
      return { topic: { $link: "/of:fid1:topic-piece-3" }, name: "3" };
    }
    expect(piece).toBe("of:fid1:topic-alias-1");
    if (verb === "addComment") {
      const id = `of:fid1:comment-${calls.length + 1}`;
      await board.write({
        [id]: { value: { author: by, body: payload.body, sentAt: 9000 } },
      });
      await writeInput({
        ...input,
        comments: [...list("comments"), link(id)],
      });
    } else if (verb === "mention" || verb === "unmention") {
      const others = list("mentioned").filter((entry) =>
        JSON.stringify(entry) !== JSON.stringify(link(payload.topic.slice(1)))
      );
      await writeInput({
        ...input,
        mentioned: verb === "mention"
          ? [...others, link(payload.topic.slice(1))]
          : others,
      });
    } else if (verb === "setBody") {
      await writeInput({ ...input, body: payload.body });
    } else if (verb === "setTitle") {
      await writeInput({ ...input, title: payload.title });
    } else if (verb === "addLink") {
      await writeInput({
        ...input,
        links: [...list("links"), {
          url: payload.url,
          kind: payload.kind ?? "web",
          label: payload.label ?? payload.url,
        }],
      });
    }
    return undefined;
  }

  /**
   * Stands in for the checkout's `cf`: answers `piece call` by performing the
   * verb on the board the way the Topics pattern does, under the invocation
   * id and session it is given, and records `piece step`.
   */
  async function cf(
    args: readonly string[],
    env: Record<string, string>,
    stdin: string,
  ): Promise<ProgramRun> {
    expect(env).toMatchObject({
      CF_API_URL: "http://localhost:1",
      CF_SPACE: SPACE,
      CF_IDENTITY: join(dir, "identity.key"),
    });
    expect(args[0]).toBe("--");
    const [, group, command, , cell] = args;
    const piece = cell.replace(/^\//, "");
    if (`${group} ${command}` === "piece step") {
      if (stepFails) return { code: 1, stdout: "", stderr: "step failed" };
      stepped.push(piece);
      return { code: 0, stdout: "", stderr: "" };
    }
    const id = args[args.indexOf("--invocation") + 1];
    const verb = args[args.indexOf("--invocation") + 2];
    const session = env.CF_INVOCATION_SESSION;
    const payload = JSON.parse(stdin);
    const repeated = calls.some((call) =>
      call.invocation === id && call.session === session
    );
    calls.push({ piece, verb, payload, invocation: id, session, args });
    if (failure !== undefined) {
      const { phase, error } = failure;
      return {
        code: 1,
        stdout: "",
        stderr: `invocation: ${id}\nsession: ${session}\n${error.message}\n` +
          (phase === undefined ? "" : `invocation: ${id} phase: ${phase}\n`),
      };
    }
    const result = repeated ? undefined : await dispatch(piece, verb, payload);
    if (garbled) return { code: 0, stdout: "log line\n{}", stderr: "" };
    return {
      code: 0,
      stdout: JSON.stringify({
        invocation: id,
        status,
        ...(result === undefined ? {} : { result }),
        ...(repeated ? { deduplicated: true } : {}),
      }),
      stderr: "wrote to space\n",
    };
  }

  const deps: TopicsDeps = {
    openDocSource: () => board.open(),
    async openSession() {
      const { client, session } = await board.mount();
      return { space: SPACE, session, close: () => client.close() };
    },
    // A terminal whose input closes, ending `watch`, once the view is live.
    get terminal() {
      let keys!: ReadableStreamDefaultController<Uint8Array>;
      const input = new ReadableStream<Uint8Array>({
        start: (controller) => void (keys = controller),
      });
      return {
        write(text: string) {
          output.push(text);
          if (text.includes("LIVE")) keys.close();
        },
        size: () => ({ columns: 100, rows: 30 }),
        setRaw() {},
        input: () => input,
        on: () => () => {},
      };
    },
    clock: { now: () => Date.UTC(2026, 9, 26, 12), after: () => () => {} },
    timeZone: "UTC",
    launcher: "/labs/runtime/cli/launcher.ts",
    run: (program, args, env, stdin) => {
      expect(program).toBe("/labs/runtime/cli/launcher.ts");
      return cf(args, env, stdin);
    },
    get stdin() {
      return {
        isTerminal: () => stdin === undefined,
        readable: new Response(stdin ?? "").body!,
      };
    },
    write: (text) => output.push(text),
    warn: (text) => warnings.push(text),
    env: (name) =>
      ({
        XDG_CACHE_HOME: join(dir, "cache"),
        HOME: dir,
        CF_IDENTITY: join(dir, "identity.key"),
        TOPICS_API_URL: "http://localhost:1",
        TOPICS_SPACE: SPACE,
        TOPICS_BOARD: `/${BOARD}`,
      })[name],
  };

  /** What the last action printed. */
  function printed(): string {
    return output.at(-1) ?? "";
  }

  describe("findTopic()", () => {
    const read = {
      topics: [
        { number: "4", address: "of:fid1:e4", piece: "of:fid1:p4" },
        { number: "42", address: "of:fid1:e42", piece: "of:fid1:p42" },
      ] as Topic[],
      spaces: ["my-space", "did:key:z6Mk-space"],
    };

    it("returns the Topic a number names, however the number is written", () => {
      for (
        const reference of [
          "42",
          "#42",
          "top/42",
          "//my-space/top/42",
          "//did:key:z6Mk-space/top/42",
        ]
      ) {
        expect(findTopic(read, reference).piece).toBe("of:fid1:p42");
      }
    });

    it("returns the Topic its address or its piece's address names", () => {
      expect(findTopic(read, "/of:fid1:e4").number).toBe("4");
      expect(findTopic(read, "of:fid1:p42").number).toBe("42");
    });

    it("throws for a Topic the board does not hold, or a number in another space, naming it once", () => {
      expect(() => findTopic(read, "#7")).toThrow(
        "The board has no Topic top/7.",
      );
      expect(() => findTopic(read, "/of:fid1:other")).toThrow(
        'The board has no Topic `"/of:fid1:other"`.',
      );
      expect(() => findTopic(read, "//other-space/top/42")).toThrow(
        "The board has no Topic //other-space/top/42.",
      );
    });
  });

  describe("searchAction()", () => {
    it("prints each matching Topic with its matching lines, and a count", async () => {
      await searchAction({}, ["oil"], deps);

      expect(printed()).toBe([
        "top/1  1970-01-01  Flaky fryer test  [1 comment]",
        "    body: when the oil is cold.",
        "    comment 1 (Ada (person)): Reproduced with cold oil.",
        "1 of 2 Topics match.",
      ].join("\n"));
    });

    it("lists the most recently active Topics up to the limit when given no terms", async () => {
      await searchAction({ limit: 1 }, [], deps);

      expect(printed()).toBe([
        "top/1  1970-01-01  Flaky fryer test  [1 comment]",
        "2 Topics match; these are the 1 most recently active (`--limit` lists more).",
      ].join("\n"));
    });

    it("matches a term that is not a valid regular expression as literal text", async () => {
      await searchAction({}, ["glaze ["], deps);

      expect(printed()).toBe("0 of 2 Topics match.");
      await searchAction({}, ["Ada ("], deps);
      expect(printed()).toMatch(/^top\/1 .*\n1 of 2 Topics match\.$/);
    });
  });

  describe("showAction()", () => {
    it("prints the Topic as Markdown with its address", async () => {
      await showAction({}, ["top/2"], deps);

      expect(printed()).toMatch(
        /^# top\/2: Donut glaze\n\nAddress: \/of:fid1:topic-piece-2\n/,
      );
      expect(printed()).toContain("Glaze ratios.");
    });

    it("refuses to read offline before there is a copy", async () => {
      await expect(showAction({ offline: true }, ["1"], deps)).rejects.toThrow(
        /no local copy/,
      );
    });

    it("reads offline from the copy as it stands, without asking the server", async () => {
      await syncAction({}, deps);
      await board.write({
        "of:fid1:input-2": { value: { title: "Renamed on the server" } },
      });
      await showAction({ offline: true }, ["2"], {
        ...deps,
        openDocSource: () => Promise.reject(new Error("went online")),
      });

      expect(printed()).toMatch(/^# top\/2: Donut glaze/);
    });

    it("prints each Topic named, in the order named", async () => {
      await showAction({}, ["2", "top/1"], deps);

      expect(printed()).toMatch(
        /^# top\/2: Donut glaze\n[\s\S]*\n\n# top\/1: Flaky fryer test\n/,
      );
    });

    it("prints the Topics the board holds, then throws naming those it does not", async () => {
      await expect(showAction({}, ["99999", "1", "#7"], deps)).rejects
        .toThrow("The board has no Topics top/99999, top/7.");
      expect(printed()).toMatch(/^# top\/1: Flaky fryer test\n/);
      expect(printed()).not.toContain("# top/2");

      const shown = output.length;

      await expect(showAction({}, ["9"], deps)).rejects.toThrow(
        "The board has no Topic top/9.",
      );
      expect(output.length).toBe(shown);
    });
  });

  describe("readTopics()", () => {
    it("warns about board entries that lead to no Topic it has read", async () => {
      await syncAction({}, deps);
      await board.write({
        "of:fid1:board-input": {
          value: {
            names: {
              "1": link("of:fid1:topic-alias-1"),
              "2": link("of:fid1:topic-piece-2"),
              "3": link("of:fid1:never-written"),
            },
          },
        },
      });
      await searchAction({}, [], deps);

      expect(warnings).toEqual([
        "These board entries lead to no Topic piece the copy has read, so " +
        "they are left out: top/3",
      ]);
    });

    it("warns about Topics not stored as the pattern stores them, and about no others", async () => {
      await searchAction({}, [], deps);
      expect(warnings).toEqual([]);
      await board.write({ "of:fid1:input-2": { value: { heading: "Moved" } } });
      await searchAction({}, [], deps);

      expect(warnings).toEqual([
        "These Topics are not stored where this client reads a Topic's title, " +
        "comments, and links, so they show blank; the deployed Topics " +
        "pattern may store Topics differently: top/2",
      ]);
    });
  });

  describe("syncAction()", () => {
    it("reads the whole board again with `rebuild`", async () => {
      await syncAction({}, deps);
      await syncAction({ rebuild: true }, deps);

      expect(printed()).toMatch(/^2 Topics; the server sent [1-9]\d* changed/);
    });

    it("prints how many Topics there are, what the server sent, and where the copy is", async () => {
      await syncAction({}, deps);
      const first = printed();
      await syncAction({}, deps);

      expect(first).toMatch(
        /^2 Topics; the server sent [1-9]\d* changed documents\./,
      );
      expect(printed()).toBe(
        "2 Topics; the server sent 0 changed documents.\nLocal copy: " +
          join(
            dir,
            "cache/commonfabric/topics/localhost%3A1",
            encodeURIComponent(SPACE),
            "of%3Afid1%3Atopics-board.json",
          ),
      );
    });
  });

  describe("commentAction()", () => {
    it("adds the comment under the agent's name, and prints the Topic it reads back on", async () => {
      await commentAction(
        { agentName: " Sol " },
        "1",
        "Warm oil fixes it.\n",
        deps,
      );

      expect(
        calls.map(({ piece, verb, payload }) => ({ piece, verb, payload })),
      )
        .toEqual([{
          piece: "of:fid1:topic-alias-1",
          verb: "addComment",
          payload: { body: "Warm oil fixes it.\n", agentName: "Sol" },
        }]);
      expect(printed()).toBe(
        "Commented on top/1.\ntop/1  1970-01-01  Flaky fryer test  [2 comments]",
      );
    });

    it("reads the comment from stdin when it is not an argument", async () => {
      stdin = "From stdin.";
      await commentAction({ agentName: "Sol" }, "top/1", undefined, deps);

      expect(calls[0].payload.body).toBe("From stdin.");
    });

    it("refuses an empty comment and a write with no agent", async () => {
      await expect(commentAction({ agentName: "Sol" }, "1", undefined, deps))
        .rejects.toThrow(/as an argument or on stdin/);
      await expect(commentAction({ agentName: " " }, "1", "Text", deps))
        .rejects.toThrow(/--agent-name/);
      expect(calls).toEqual([]);
    });

    it("makes each run a new invocation, announcing its id before it dispatches", async () => {
      await commentAction({ agentName: "Sol" }, "1", "Done.", deps);
      await commentAction({ agentName: "Sol" }, "1", "Done.", deps);

      expect(calls.map((call) => call.invocation)).toEqual([
        expect.stringMatching(/^topics-/),
        expect.stringMatching(/^topics-/),
      ]);
      expect(calls[1].invocation).not.toBe(calls[0].invocation);
      expect(calls[1].session).toBe(calls[0].session);
      expect(warnings).toEqual(
        calls.map((call) =>
          `Writing as invocation ${call.invocation}; if no answer arrives, run ` +
          `the same command with \`--invocation ${call.invocation}\` to settle it.`
        ),
      );
      expect(printed()).toMatch(/\[3 comments\]$/);
    });

    it("settles the invocation `--invocation` names on its first outcome", async () => {
      await commentAction({ agentName: "Sol" }, "1", "Once.", deps);
      const invocation = calls[0].invocation;
      await commentAction({ agentName: "Sol", invocation }, "1", "Once.", deps);

      expect(calls[1].invocation).toBe(invocation);
      expect(printed()).toMatch(
        /^Commented on top\/1, by an earlier run of this invocation\.\n.*\[2 comments\]$/,
      );
    });

    it("throws when the comment does not read back, without offering a retry that cannot help", async () => {
      applyWrites = false;

      await expect(commentAction({ agentName: "Sol" }, "1", "Lost.", deps))
        .rejects.toThrow(
          /^The write settled but does not read back on top\/1\.$/,
        );
    });

    it("does not take an earlier identical comment as the one it wrote", async () => {
      await commentAction({ agentName: "Sol" }, "1", "Done.", deps);
      applyWrites = false;

      await expect(commentAction({ agentName: "Sol" }, "1", "Done.", deps))
        .rejects.toThrow(/does not read back/);
    });

    it("does not take a retracted identical comment as the one a repeated invocation wrote", async () => {
      await board.write({
        "of:fid1:input-1": {
          value: {
            ...INPUT_1,
            comments: [link("of:fid1:comment-1"), {
              author: { kind: "agent", name: "Sol" },
              body: "Done.",
              sentAt: 4000,
              removedAt: 5000,
            }],
          },
        },
      });
      applyWrites = false;
      const options = { agentName: "Sol", invocation: "topics-retracted" };
      await expect(commentAction(options, "1", "Done.", deps)).rejects
        .toThrow(/does not read back/);

      await expect(commentAction(options, "1", "Done.", deps)).rejects
        .toThrow(/does not read back/);
      expect(calls.map((call) => call.invocation)).toEqual([
        "topics-retracted",
        "topics-retracted",
      ]);
    });

    it("throws when the call does not settle, saying how to settle the write", async () => {
      status = "committed";

      await expect(commentAction({ agentName: "Sol" }, "1", "Slow.", deps))
        .rejects.toThrow(
          /^`addComment` did not settle: .*status:"committed".*\nThe write may have committed: run the same command with `--invocation topics-/,
        );
    });

    it("says how to settle a write whose output is not an outcome", async () => {
      garbled = true;

      await expect(commentAction({ agentName: "Sol" }, "1", "Noisy.", deps))
        .rejects.toThrow(
          /^`addComment` answered `"log line.*`\.\nThe write may have committed/,
        );
    });

    it("says how to settle a write that failed after it dispatched, or at a phase it did not name, and not one that failed before", async () => {
      failure = { phase: "dispatched", error: new Error("Connection lost.") };
      await expect(commentAction({ agentName: "Sol" }, "1", "A.", deps))
        .rejects.toThrow(
          /^`cf piece call` failed:\n[\s\S]*Connection lost\.\ninvocation: \S+ phase: dispatched\nThe write may have committed: run the same command with `--invocation topics-/,
        );
      failure = { phase: undefined, error: new Error("Killed.") };
      await expect(commentAction({ agentName: "Sol" }, "1", "B.", deps))
        .rejects.toThrow(
          /^`cf piece call` failed:\n[\s\S]*Killed\.\nThe write may have committed/,
        );
      failure = { phase: "initial_sync", error: new Error("No such verb.") };

      await expect(commentAction({ agentName: "Sol" }, "1", "C.", deps))
        .rejects.toThrow(
          /^`cf piece call` failed:\n[\s\S]*No such verb\.\ninvocation: \S+ phase: initial_sync$/,
        );
    });

    it("leaves the invocation session out of a failure's report", async () => {
      failure = { phase: "dispatched", error: new Error("Lost.") };
      const report = commentAction({ agentName: "Sol" }, "1", "A.", deps).then(
        () => "",
        (error: Error) => error.message,
      );

      expect(await report).toContain("Lost.");
      expect(await report).not.toContain("session:");
    });

    it("sends `cf piece call` the cell, the invocation, the verb, and the payload on stdin", async () => {
      await commentAction({ agentName: "Sol" }, "1", "Hello.", deps);
      stdin = "Body.";
      await newAction({ agentName: "Sol" }, "Fresh", undefined, deps);
      const [comment, filed] = calls;

      // `cf piece call` takes `-` as its payload from stdin, and the words
      // after `--` as how to shape its printed result.
      expect(comment.args).toEqual([
        "--",
        "piece",
        "call",
        "--cell",
        "/of:fid1:topic-alias-1",
        "--invocation",
        comment.invocation,
        "addComment",
        "-",
      ]);
      expect(filed.args).toEqual([
        "--",
        "piece",
        "call",
        "--cell",
        `/${BOARD}`,
        "--invocation",
        filed.invocation,
        "addTopic",
        "-",
        "--",
        "--schema",
        JSON.stringify({
          properties: { topic: { $link: true }, name: { type: "string" } },
        }),
      ]);
    });
  });

  describe("bodyAction()", () => {
    it("replaces the body", async () => {
      await bodyAction({ agentName: "Sol" }, "1", "New body.", deps);

      expect(calls[0].verb).toBe("setBody");
      expect(printed()).toMatch(/^Replaced the body of top\/1\./);
    });
  });

  describe("titleAction()", () => {
    it("renames the Topic", async () => {
      await titleAction({ agentName: "Sol" }, "1", "Fryer fixed", deps);

      expect(calls[0].payload).toEqual({
        title: "Fryer fixed",
        agentName: "Sol",
      });
      expect(printed()).toBe(
        "Retitled top/1.\ntop/1  1970-01-01  Fryer fixed  [1 comment]",
      );
    });
  });

  describe("linkAction()", () => {
    it("does not take a link already there as the one it added", async () => {
      applyWrites = false;

      await expect(
        linkAction(
          { agentName: "Sol" },
          "1",
          "https://example.com/pull/1",
          undefined,
          deps,
        ),
      ).rejects.toThrow(/does not read back/);
    });

    it("adds a link with its kind and label", async () => {
      await linkAction(
        { agentName: "Sol", kind: "pr" },
        "1",
        "https://example.com/pull/2",
        "Second fix",
        deps,
      );

      expect(calls[0].payload).toEqual({
        url: "https://example.com/pull/2",
        kind: "pr",
        label: "Second fix",
        agentName: "Sol",
      });
      expect(printed()).toMatch(/^Linked top\/1\./);
    });

    it("leaves the kind and label to the verb when they are not given", async () => {
      await linkAction(
        { agentName: "Sol" },
        "1",
        "https://example.com/a",
        undefined,
        deps,
      );

      expect(calls[0].payload).toEqual({
        url: "https://example.com/a",
        agentName: "Sol",
      });
    });
  });

  describe("newAction()", () => {
    it("files the Topic, steps it, and prints its number and address", async () => {
      stdin = "The body.";
      await newAction({ agentName: "Sol" }, "A new Topic", undefined, deps);

      expect(
        calls.map(({ piece, verb, payload }) => ({ piece, verb, payload })),
      )
        .toEqual([{
          piece: BOARD,
          verb: "addTopic",
          payload: {
            title: "A new Topic",
            body: "The body.",
            agentName: "Sol",
          },
        }]);
      expect(stepped).toEqual(["of:fid1:topic-piece-3"]);
      expect(printed()).toBe(
        "Created top/3 (/of:fid1:topic-piece-3).\ntop/3  -           A new Topic",
      );
    });

    it("throws when the call names no created Topic", async () => {
      applyWrites = false;

      await expect(newAction({ agentName: "Sol" }, "T", "B", deps)).rejects
        .toThrow(
          /without naming the Topic it created/,
        );
      expect(stepped).toEqual([]);
    });
  });

  describe("mentionAction()", () => {
    it("recognizes a reference already stored under another address of the same piece", async () => {
      await board.write({
        "of:fid1:another-alias-2": { value: link("of:fid1:topic-piece-2") },
      });
      input = { ...input, mentioned: [link("of:fid1:another-alias-2")] };
      await board.write({ "of:fid1:input-1": { value: input } });
      applyWrites = false;

      await mentionAction({}, "mention", "1", "2", deps);
      expect(printed()).toMatch(/^top\/1 now mentions top\/2\./);
      await expect(mentionAction({}, "unmention", "1", "2", deps)).rejects
        .toThrow(/does not read back on top\/1/);
    });

    it("records and removes a reference to another Topic", async () => {
      await mentionAction({}, "mention", "1", "2", deps);
      await mentionAction({}, "unmention", "1", "2", deps);

      expect(calls.map(({ verb, payload }) => [verb, payload])).toEqual([
        ["mention", { topic: "/of:fid1:topic-piece-2" }],
        ["unmention", { topic: "/of:fid1:topic-piece-2" }],
      ]);
      expect(output.map((text) => text.split("\n")[0])).toEqual([
        "top/1 now mentions top/2.",
        "top/1 no longer mentions top/2.",
      ]);
    });
  });

  describe("stdinText()", () => {
    it("returns everything a piped stdin holds", async () => {
      const readable = new Response("piped text").body!;

      expect(await stdinText({ isTerminal: () => false, readable })).toBe(
        "piped text",
      );
    });

    it("returns `undefined` for a terminal, without reading it", async () => {
      const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull: () => {
          throw new Error("read a terminal");
        },
      });

      expect(await stdinText({ isTerminal: () => true, readable }))
        .toBeUndefined();
    });
  });

  describe("main()", () => {
    /** Runs the words after `deno task topics`. */
    async function run(...args: string[]): Promise<void> {
      await main(args, deps);
    }

    it("prints the usage, which says a write is recovered by naming its invocation", async () => {
      await run();
      await run("search", "--help");
      const help = USAGE.replaceAll(/\s+/g, " ");

      expect(output).toEqual([USAGE, USAGE]);
      expect(help).toContain(
        "run the same command with --invocation <id>: that settles on the " +
          "first outcome, where running it again without the id writes a " +
          "second time.",
      );
    });

    it("refuses to `watch` when standard input is not a terminal", async () => {
      stdin = "";

      await expect(run("watch")).rejects.toThrow(
        "`watch` takes over a terminal; run it in one.",
      );
      expect(output).toEqual([]);
    });

    it("shows the board live on the whole terminal for `watch`", async () => {
      await run("watch");
      const drawn = output.join("");

      expect(drawn).toContain("● LIVE");
      expect(drawn).toContain("Donut glaze");
      expect(output.at(-1)).toContain("\x1b[?1049l");
    });

    it("passes each command's arguments and options to its action", async () => {
      await run("search", "oil", "cold", "-n", "1");
      expect(printed()).toMatch(/^top\/1 .*\n.*\n.*\n1 of 2 Topics match\.$/);
      await run("show", "top/2", "--offline");
      expect(printed()).toMatch(/^# top\/2: Donut glaze/);
      await run("sync", "--rebuild");
      expect(printed()).toMatch(/^2 Topics; the server sent [1-9]/);
      await run("comment", "1", "Via the command.", "--agent-name", "Sol");
      await run("body", "1", "007", "--agent-name", "Sol");
      await run("title", "1", "New title", "--agent-name", "Sol");
      await run(
        "link",
        "1",
        "https://example.com/c",
        "Label",
        "--kind",
        "pr",
        "--agent-name",
        "Sol",
      );
      await run("mention", "1", "2", "--invocation", "topics-chosen");
      await run("unmention", "1", "2");
      stdin = "Body from stdin.";
      await run("new", "Filed via the command", "--agent-name", "Sol");

      expect(calls.map(({ verb, payload }) => [verb, payload])).toEqual([
        ["addComment", { body: "Via the command.", agentName: "Sol" }],
        ["setBody", { body: "007", agentName: "Sol" }],
        ["setTitle", { title: "New title", agentName: "Sol" }],
        ["addLink", {
          url: "https://example.com/c",
          kind: "pr",
          label: "Label",
          agentName: "Sol",
        }],
        ["mention", { topic: "/of:fid1:topic-piece-2" }],
        ["unmention", { topic: "/of:fid1:topic-piece-2" }],
        ["addTopic", {
          title: "Filed via the command",
          body: "Body from stdin.",
          agentName: "Sol",
        }],
      ]);
      expect(calls[4].invocation).toBe("topics-chosen");
    });

    it("steps the Topic each write wrote to, once the write settles", async () => {
      await run("comment", "1", "Hi.", "--agent-name", "Sol");
      await run("title", "1", "Fryer", "--agent-name", "Sol");
      await run("mention", "1", "2");
      await run("new", "Filed", "Body.", "--agent-name", "Sol");

      expect(stepped).toEqual([
        "of:fid1:topic-alias-1",
        "of:fid1:topic-alias-1",
        "of:fid1:topic-alias-1",
        "of:fid1:topic-piece-3",
      ]);
    });

    it("says how to step a Topic that was written to when its step fails, without writing again", async () => {
      stepFails = true;
      const failure = await run("comment", "1", "Hi.", "--agent-name", "Sol")
        .then(() => "", (error: Error) => error.message);
      const id = /`--invocation (\S+)`/.exec(failure)?.[1] ?? "";

      expect(failure).toMatch(
        /^`cf piece step` failed:\nstep failed\nThe write was made, but the board will not show it until \/of:fid1:topic-alias-1 runs: run the same command with `--invocation topics-\S+` to run it without writing again\.$/,
      );

      stepFails = false;
      await run(
        "comment",
        "1",
        "Hi.",
        "--agent-name",
        "Sol",
        "--invocation",
        id,
      );

      expect(stepped).toEqual(["of:fid1:topic-alias-1"]);
      expect(calls.map((call) => call.invocation)).toEqual([id, id]);
      expect(printed()).toMatch(
        /^Commented on top\/1, by an earlier run of this invocation\./,
      );
    });

    it("attributes a write to `CF_AGENT_NAME` unless `--agent-name` names another agent", async () => {
      const named = {
        ...deps,
        env: (name: string) =>
          name === "CF_AGENT_NAME" ? "Envy" : deps.env(name),
      };
      await main(["comment", "1", "From the environment."], named);
      await main(
        ["comment", "1", "From the flag.", "--agent-name", "Tom"],
        named,
      );

      expect(calls.map((call) => call.payload.agentName)).toEqual([
        "Envy",
        "Tom",
      ]);
    });

    it("throws for an option the command does not take, or an empty invocation id", async () => {
      await expect(run("comment", "1", "x", "--kind", "pr")).rejects.toThrow(
        "`comment` takes no `--kind`.",
      );
      await expect(run("show", "1", "--limit", "3")).rejects.toThrow(
        "`show` takes no `--limit`.",
      );
      await expect(run("comment", "1", "x", "--offline")).rejects.toThrow(
        "`comment` takes no `--offline`.",
      );
      await expect(run("search", "--rebuild")).rejects.toThrow(
        "`search` takes no `--rebuild`.",
      );
      await expect(
        run("comment", "1", "x", "--agent-name", "Sol", "--invocation", " "),
      ).rejects.toThrow("`--invocation` names an invocation id.");
      expect(calls).toEqual([]);
    });

    it("reads a relative identity path from where the command was typed, for reads and writes alike", async () => {
      const identities: string[] = [];
      const typedIn: TopicsDeps = {
        ...deps,
        env: (name: string) =>
          name === "INIT_CWD"
            ? dir
            : name === "CF_IDENTITY"
            ? "identity.key"
            : deps.env(name),
        run: (_program, args, env, stdin) => {
          identities.push(env.CF_IDENTITY);
          return cf(
            args,
            { ...env, CF_IDENTITY: join(dir, "identity.key") },
            stdin,
          );
        },
      };
      await main(["comment", "1", "Hi.", "--agent-name", "Sol"], typedIn);
      await main(
        ["comment", "1", "Again.", "--agent-name", "Sol", "-i", "other.key"],
        typedIn,
      );

      // Each write runs `cf` twice: the call, then the step.
      expect(identities).toEqual([
        join(dir, "identity.key"),
        join(dir, "identity.key"),
        join(dir, "other.key"),
        join(dir, "other.key"),
      ]);
    });

    it("throws for an unknown command, an unknown option, a wrong count of arguments, or a bad limit", async () => {
      await expect(run("frobnicate")).rejects.toThrow(
        'Unknown command `"frobnicate"`',
      );
      await expect(run("search", "--verbose")).rejects.toThrow(
        'Unknown option `"--verbose"`',
      );
      await expect(run("show")).rejects.toThrow(
        "`show` takes at least 1 arguments",
      );
      await expect(run("title", "1")).rejects.toThrow(
        "`title` takes 2 arguments",
      );
      await expect(run("new", "a", "b", "c")).rejects.toThrow(
        "`new` takes 1 to 2 arguments",
      );
      await expect(run("search", "-n", "0")).rejects.toThrow(
        "`--limit` takes a positive whole number",
      );
      expect(calls).toEqual([]);
    });

    it("searches only the parts `--in` names, leaving out Topics whose titles match `--exclude`", async () => {
      await run("search", "reproduced", "--in", "title, body");
      const inTitleOrBody = printed();
      await run("search", "reproduced", "--in", "comments");
      const inComments = printed();
      await run("search", "--exclude", "^Flaky", "--exclude", "nothing");

      expect(inTitleOrBody).toBe("0 of 2 Topics match.");
      expect(inComments).toMatch(/^top\/1 [\s\S]*1 of 2 Topics match\.$/);
      expect(printed()).toMatch(/^top\/2 .*\n1 of 2 Topics match\.$/);
      await expect(run("search", "--in", "title,bodies")).rejects.toThrow(
        "`--in` takes a comma-separated list of title, body, comments, " +
          "links, authors.",
      );
    });

    it("prints JSON for `search --json` and `show --json`", async () => {
      await run("search", "cold", "--json");
      const found = JSON.parse(printed());
      await run("show", "1", "2", "--json");
      const shown = JSON.parse(printed());

      expect(found).toEqual({
        matching: 1,
        topics: [{
          number: "1",
          address: "/of:fid1:topic-alias-1",
          title: "Flaky fryer test",
          createdAt: 1000,
          createdBy: "Sol (agent)",
          lastActivityAt: expect.any(Number),
          comments: 1,
          matches: [
            "body: when the oil is cold.",
            "comment 1 (Ada (person)): Reproduced with cold oil.",
          ],
        }],
      });
      expect(shown.map((topic: { number: string }) => topic.number)).toEqual(
        ["1", "2"],
      );
      expect(shown[0].comments).toEqual([{
        number: 1,
        author: "Ada (person)",
        body: "Reproduced with cold oil.",
        sentAt: 2000,
      }]);
    });

    it("shows only the comments `--last` and `--comments-since` leave", async () => {
      await board.write({
        "of:fid1:input-1": {
          value: {
            ...INPUT_1,
            comments: [
              link("of:fid1:comment-1"),
              { author: { name: "Bo" }, body: "Day two.", sentAt: DAY_TWO },
              { author: { name: "Cy" }, body: "Later.", sentAt: DAY_TWO + 1 },
            ],
          },
        },
      });
      const numbers = () =>
        [...printed().matchAll(/^### (\d+)\./gm)].map((match) => match[1]);
      await run("show", "1", "--last", "2");
      const last = numbers();
      await run("show", "1", "--comments-since", "2026-10-27");
      const sinceDay = numbers();
      await run("show", "1", "--comments-since", "2026-10-27T12:00:00.001Z");
      const sinceTime = numbers();

      expect(last).toEqual(["2", "3"]);
      expect(sinceDay).toEqual(
        Date.parse("2026-10-27T00:00") <= DAY_TWO ? ["2", "3"] : ["3"],
      );
      expect(sinceTime).toEqual(["3"]);
      await expect(run("show", "1", "--last", "0")).rejects.toThrow(
        "`--last` takes a positive whole number.",
      );
      await expect(run("show", "1", "--comments-since", "soon")).rejects
        .toThrow("`--comments-since` takes a date or time");
      await expect(run("search", "--last", "2")).rejects.toThrow(
        "`search` takes no `--last`.",
      );
      await expect(run("show", "1", "--exclude", "x")).rejects.toThrow(
        "`show` takes no `--exclude`.",
      );
      await expect(run("sync", "--json")).rejects.toThrow(
        "`sync` takes no `--json`.",
      );
    });
  });

  describe("runProgram()", () => {
    const TOPICS = fromFileUrl(new URL("./topics.ts", import.meta.url));

    it("runs a program with arguments, added variables, and stdin, returning what it wrote and its exit code", async () => {
      const program = join(dir, "echo.ts");
      await Deno.writeTextFile(
        program,
        `const input = await new Response(Deno.stdin.readable).text();
console.log(JSON.stringify([Deno.args, Deno.env.get("TOPICS_ECHO"), input]));
console.error("to stderr");
Deno.exit(3);`,
      );
      const run = await runProgram(
        program,
        ["one", "--two"],
        { TOPICS_ECHO: "set" },
        "piped in",
      );

      expect(run).toEqual({
        code: 3,
        stdout: `${JSON.stringify([["one", "--two"], "set", "piped in"])}\n`,
        stderr: "to stderr\n",
      });
    });

    it("returns what a program reported when it exits without reading its input", async () => {
      const program = join(dir, "early.ts");
      await Deno.writeTextFile(
        program,
        `console.error("refused"); Deno.exit(4);`,
      );

      expect(
        await runProgram(program, [], {}, "x".repeat(4 * 1024 * 1024)),
      ).toEqual({ code: 4, stdout: "", stderr: "refused\n" });
    });

    it("runs this script, which prints its usage and reports a bad command on stderr", async () => {
      const help = await runProgram(TOPICS, ["--help"], {}, "");
      const bad = await runProgram(TOPICS, ["frobnicate"], {}, "");

      expect(help).toEqual({ code: 0, stdout: `${USAGE}\n`, stderr: "" });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toBe(
        'Unknown command `"frobnicate"`; see `--help`.\n',
      );
    });
  });

  describe("writeSession()", () => {
    /** A board whose session is kept at `session`. */
    function at(session: string) {
      return {
        apiUrl: "",
        space: "",
        identity: "",
        board: "",
        mirror: "",
        session,
      };
    }

    it("throws when the session cannot be put in place, leaving nothing behind", async () => {
      const state = join(dir, "state");

      await expect(
        writeSession(at(join(state, `${"x".repeat(260)}.invocation-session`))),
      ).rejects.toThrow(/name too long/i);
      expect([...Deno.readDirSync(state)]).toEqual([]);
    });

    it("mints a session once, readable only by its owner, and returns it after", async () => {
      const path = join(dir, "state", "board.invocation-session");
      const first = await writeSession(at(path));
      const second = await writeSession(at(path));

      expect(second).toBe(first);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
    });
  });
});
