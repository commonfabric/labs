import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricPlainObject } from "@commonfabric/api";
import { taggedHashStringOf } from "@commonfabric/data-model";
import type { EntityDocument } from "@commonfabric/memory/v2";

import type { ProgramRun, TopicsDeps } from "../../topics/tools/topics.ts";
import {
  BOARD,
  type BoardServer,
  boardServer,
  INPUT_1,
  link,
  SPACE,
} from "../../topics/tools/board-fixture.ts";
import { main, type ReportsDeps, sendAction } from "./reports.ts";

/** The reports board's piece, in the fixture's space beside its Topics. */
const REPORTS = "of:fid1:reports-board";
const ADA = "did:key:z6MkAda";
const EVE = "did:key:z6MkEve";
const TRI = "did:key:z6MkTriager";

/** Words no Topic may carry. */
const SECRET = "Lunch with Pat about the merger";

/** The schema document a label envelope names. */
const SCHEMA = `cid:${taggedHashStringOf(true)}`;

/** A report record's document, labeled `authored-by` `author`. */
function reportDoc(
  record: FabricPlainObject,
  author: string | undefined,
): EntityDocument {
  return {
    value: record,
    ...(author === undefined ? {} : {
      cfc: {
        version: 2,
        schemaHash: taggedHashStringOf(true),
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "declared",
            label: { integrity: [{ kind: "authored-by", subject: author }] },
          }],
        },
      },
    }),
  };
}

/** The id a sender would derive for the report named `name`: 32 hex. */
function idOf(name: string): string {
  return [...new TextEncoder().encode(name)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")
    .padEnd(32, "0").slice(0, 32);
}

/** A request `send` takes, for a want stopped at gmail sync. */
function request(
  name: string,
  release = "2026.11.18",
  id = idOf(name),
): FabricPlainObject {
  return {
    agentName: "cfs-feedback",
    id,
    name,
    kind: "broke",
    words: SECRET,
    structured: {
      source: "failure-card",
      cfs: { release },
      want: { id: "w1", cause: "auth-expired", stop: "gmail-sync", since: 1 },
      futureField: { kept: true },
    },
  };
}

describe("feedback-reports command", () => {
  let board: BoardServer;
  let dir: string;
  let output: string[];
  let topicsOutput: string[];
  let stdin: string | undefined;
  /** The verbs dispatched, in order. */
  let verbs: string[];
  /** The reports board's input: its report documents and Topic links. */
  let reportIds: string[];
  /** The ids of the reports on the board. */
  let ids: string[];
  let topicOf: Record<string, string>;
  /** Who wrote each link in `topicOf`, by report id. */
  let linkAuthors: Record<string, string>;
  /** Who the fake `cf` writes reports and links as. */
  let sender: string;
  let linker: string;
  let topicInput: FabricPlainObject;
  /** What each invocation settled with, so naming one again writes nothing. */
  let settled: Map<string, unknown>;
  /** How many `linkTopic` calls fail before one is made. */
  let failingLinks: number;

  beforeEach(async () => {
    board = await boardServer();
    dir = await Deno.makeTempDir({ prefix: "feedback-reports-tool-" });
    output = [];
    topicsOutput = [];
    stdin = undefined;
    verbs = [];
    reportIds = [];
    ids = [];
    topicOf = {};
    linkAuthors = {};
    sender = ADA;
    linker = TRI;
    settled = new Map();
    failingLinks = 0;
    topicInput = { ...INPUT_1 };
    await board.write({
      [REPORTS]: { value: {}, argument: link("of:fid1:reports-input") },
      [SCHEMA]: { value: true },
    });
    await writeReportsInput();
  });

  afterEach(async () => {
    await board.close();
    await Deno.remove(dir, { recursive: true });
  });

  /** Writes the board's input, each link labeled `authored-by` its writer. */
  function writeReportsInput() {
    return board.write({
      "of:fid1:reports-input": {
        value: { reports: reportIds.map((id) => link(id)), topicOf },
        cfc: {
          version: 2,
          schemaHash: taggedHashStringOf(true),
          labelMap: {
            version: 1,
            entries: Object.entries(linkAuthors).map(([id, subject]) => ({
              path: ["topicOf", id],
              origin: "declared",
              label: { integrity: [{ kind: "authored-by", subject }] },
            })),
          },
        },
      },
    });
  }

  /** Links report `id` to `topic` as `by` would. */
  async function linkReport(id: string, topic: string, by: string) {
    topicOf = { ...topicOf, [id]: topic };
    linkAuthors = { ...linkAuthors, [id]: by };
    await writeReportsInput();
  }

  /** Puts a report on the board as `author` wrote it. */
  async function addReport(
    record: FabricPlainObject,
    // `null` for a report nothing attests: no label at all.
    author: string | null = ADA,
  ) {
    const id = `of:fid1:report-${reportIds.length + 1}`;
    reportIds.push(id);
    ids.push(String(record.id));
    const { agentName: _, ...stored } = record;
    await board.write({
      [id]: reportDoc({ ...stored, createdAt: 1 }, author ?? undefined),
    });
    await writeReportsInput();
  }

  /**
   * Stands in for the checkout's `cf`: performs each verb the way the
   * reports pattern and the Topics pattern store their effects.
   */
  async function cf(
    args: readonly string[],
    _env: Record<string, string>,
    input: string,
  ): Promise<ProgramRun> {
    const ok = (result?: unknown) => ({
      code: 0,
      stdout: JSON.stringify({
        status: "settled",
        ...(result === undefined ? {} : { result }),
      }),
      stderr: "",
    });
    if (args[2] === "step") return ok();
    const id = args[args.indexOf("--invocation") + 1];
    const verb = args[args.indexOf("--invocation") + 2];
    const payload = JSON.parse(input);
    if (settled.has(id)) {
      return {
        code: 0,
        stdout: JSON.stringify({
          status: "settled",
          result: settled.get(id),
          deduplicated: true,
        }),
        stderr: "",
      };
    }
    verbs.push(verb);
    if (verb === "linkTopic" && failingLinks > 0) {
      failingLinks--;
      return {
        code: 1,
        stdout: "",
        stderr: `connection lost\ninvocation: ${id} phase: initial_sync\n`,
      };
    }
    const answer = await perform(verb, payload);
    if (answer.code === 0) {
      settled.set(id, JSON.parse(answer.stdout).result);
    }
    return answer;
  }

  /** Performs `verb` as the reports and Topics patterns store its effects. */
  async function perform(
    verb: string,
    payload: Record<string, string>,
  ): Promise<ProgramRun> {
    const ok = (result?: unknown) => ({
      code: 0,
      stdout: JSON.stringify({
        status: "settled",
        ...(result === undefined ? {} : { result }),
      }),
      stderr: "",
    });
    if (verb === "addReport") {
      if (ids.includes(payload.id)) {
        return {
          code: 1,
          stdout: "",
          stderr: `Error: addReport rejected: duplicate-id: a report with ` +
            `id ${payload.id} is already on the board\n` +
            "invocation: x phase: dispatched\n",
        };
      }
      await addReport(payload, sender);
      return ok({ id: payload.id, name: payload.name });
    }
    if (verb === "linkTopic") {
      await linkReport(payload.id, payload.topic, linker);
      return ok();
    }
    if (verb === "addTopic") {
      await board.write({
        "of:fid1:topic-piece-3": {
          value: {},
          argument: link("of:fid1:input-3"),
        },
        "of:fid1:input-3": {
          value: { title: payload.title, body: payload.body, createdAt: 5 },
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
      return ok({ topic: { $link: "/of:fid1:topic-piece-3" } });
    }
    if (verb === "setBody") {
      topicInput = { ...topicInput, body: payload.body };
    } else if (verb === "addComment") {
      const comments = Array.isArray(topicInput.comments)
        ? topicInput.comments
        : [];
      topicInput = {
        ...topicInput,
        comments: [...comments, { body: payload.body, sentAt: 9000 }],
      };
    }
    await board.write({ "of:fid1:input-1": { value: topicInput } });
    return ok();
  }

  const env = (name: string) =>
    ({
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_STATE_HOME: join(dir, "state"),
      HOME: dir,
      CF_IDENTITY: join(dir, "identity.key"),
      TOPICS_API_URL: "http://localhost:1",
      TOPICS_SPACE: SPACE,
      TOPICS_BOARD: BOARD,
      FEEDBACK_REPORTS_API_URL: "http://localhost:1",
      FEEDBACK_REPORTS_SPACE: SPACE,
      FEEDBACK_REPORTS_BOARD: `/${REPORTS}`,
    })[name];

  const stdinOf = () => ({
    isTerminal: () => stdin === undefined,
    readable: new Response(stdin ?? "").body!,
  });

  const topics: TopicsDeps = {
    openDocSource: () => board.open(),
    openSession: () => Promise.reject(new Error("not used")),
    terminal: {
      write() {},
      size: () => ({ columns: 80, rows: 24 }),
      setRaw() {},
      input: () => new ReadableStream(),
      on: () => () => {},
      hold: () => () => {},
    },
    clock: { now: () => 0, after: () => () => {} },
    timeZone: "UTC",
    launcher: "/labs/runtime/cli/launcher.ts",
    run: (_program, args, cfEnv, input) => cf(args, cfEnv, input),
    serverExecutes: () => Promise.resolve(true),
    get stdin() {
      return stdinOf();
    },
    write: (text) => topicsOutput.push(text),
    warn: () => {},
    env,
    openUrl: () => Promise.resolve(),
    copyText: () => Promise.resolve(),
    identityDid: () => Promise.resolve(ADA),
  };

  const deps: ReportsDeps = {
    openDocSource: () => board.open(),
    launcher: "/labs/runtime/cli/launcher.ts",
    run: (_program, args, cfEnv, input) => cf(args, cfEnv, input),
    get stdin() {
      return stdinOf();
    },
    write: (text) => output.push(text),
    warn: () => {},
    env,
    topics,
  };

  async function trustedFile(...dids: string[]): Promise<string> {
    const path = join(dir, "trusted.txt");
    await Deno.writeTextFile(path, dids.join("\n"));
    return path;
  }

  describe("send", () => {
    it("writes the report on stdin and answers with its id and name", async () => {
      stdin = JSON.stringify(request("quiet-heron-41"));

      const status = await main(["send"], deps);

      expect(status).toBe(0);
      expect(JSON.parse(output[0])).toEqual({
        ok: true,
        id: idOf("quiet-heron-41"),
        name: "quiet-heron-41",
      });
      expect(verbs).toEqual(["addReport"]);
    });

    it("writes a report whose name another install's report already has", async () => {
      await addReport(request("quiet-heron-41", "2026.11.18", "f".repeat(32)));
      stdin = JSON.stringify(request("quiet-heron-41"));

      expect(await main(["send"], deps)).toBe(0);
      expect(ids).toEqual(["f".repeat(32), idOf("quiet-heron-41")]);
    });

    it("answers with the board's code when the board refuses the report", async () => {
      await addReport(request("quiet-heron-41"));
      stdin = JSON.stringify(request("quiet-heron-41"));

      expect(await main(["send"], deps)).toBe(1);
      expect(JSON.parse(output[0])).toEqual({
        ok: false,
        code: "duplicate-id",
        message: `a report with id ${
          idOf("quiet-heron-41")
        } is already on the board`,
      });
    });

    it("answers bad-request for stdin that is not a JSON object, writing nothing", async () => {
      for (const text of ["not json", "[1]", undefined]) {
        stdin = text;
        const answer = await sendAction({}, deps);
        expect(answer).toMatchObject({ ok: false, code: "bad-request" });
      }
      expect(verbs).toEqual([]);
    });

    it("answers not-configured when no board is named, writing nothing", async () => {
      stdin = JSON.stringify(request("quiet-heron-41"));
      const answer = await sendAction({}, {
        ...deps,
        env: (name) => name.startsWith("FEEDBACK_") ? undefined : env(name),
      });

      expect(answer).toMatchObject({ ok: false, code: "not-configured" });
      expect(verbs).toEqual([]);
    });
  });

  describe("triage", () => {
    /** Runs `triage` trusting Ada's reports and TRI's links. */
    async function triage(...extra: string[]): Promise<number> {
      const triagers = join(dir, "triagers.txt");
      await Deno.writeTextFile(triagers, TRI);
      return await main([
        "triage",
        "--trusted",
        await trustedFile(ADA),
        "--triagers",
        triagers,
        "--agent-name",
        "Triage",
        ...extra,
      ], deps);
    }

    it("files a templated Topic for a trusted sender's report and links the report to it", async () => {
      await addReport(request("quiet-heron-41"));
      await addReport(request("calm-otter-7"));

      await triage();

      expect(verbs).toEqual(["addTopic", "linkTopic", "linkTopic"]);
      expect(topicOf).toEqual({
        [idOf("quiet-heron-41")]: "of:fid1:topic-piece-3",
        [idOf("calm-otter-7")]: "of:fid1:topic-piece-3",
      });
      expect(topicsOutput[0]).toContain("Created top/3");
      expect(output.at(-1)).toContain("Filed 1 Topics and updated 0");
    });

    it("settles the Topic an interrupted run filed rather than filing it again", async () => {
      await addReport(request("quiet-heron-41"));
      await addReport(request("calm-otter-7"));
      failingLinks = 1;

      await expect(triage()).rejects.toThrow("connection lost");
      expect(verbs).toEqual(["addTopic", "linkTopic"]);
      expect(topicOf).toEqual({});

      verbs = [];
      await triage();

      // The second run names the first run's invocation, which settles on the
      // Topic already filed: no second `addTopic` is dispatched.
      expect(verbs).toEqual(["linkTopic", "linkTopic"]);
      expect(Object.values(topicOf)).toEqual([
        "of:fid1:topic-piece-3",
        "of:fid1:topic-piece-3",
      ]);
    });

    it("replaces only its own section of a filed Topic's body, commenting only on a new release", async () => {
      await addReport(request("quiet-heron-41"));
      await linkReport(idOf("quiet-heron-41"), "of:fid1:topic-alias-1", TRI);
      await addReport(request("calm-otter-7"));

      await triage();

      expect(verbs).toEqual(["setBody", "linkTopic"]);
      // The engineers' text the Topic held is kept, and the section added.
      expect(topicInput.body).toContain(String(INPUT_1.body));
      expect(topicInput.body).toContain("- Count: 2");
      expect(topicOf[idOf("calm-otter-7")]).toBe("of:fid1:topic-alias-1");

      topicInput = {
        ...topicInput,
        body: `${String(topicInput.body)}\n\nOwner: Bo. Next step: bisect.`,
      };
      await board.write({ "of:fid1:input-1": { value: topicInput } });
      verbs = [];
      await addReport(request("brave-lynx-3", "2026.12.01"));
      await triage();

      expect(verbs).toEqual(["addComment", "setBody", "linkTopic"]);
      expect(JSON.stringify(topicInput.comments)).toContain(
        "New CFS releases: 2026.12.01.",
      );
      const body = String(topicInput.body);
      expect(body.startsWith(String(INPUT_1.body))).toBe(true);
      expect(body.endsWith("Owner: Bo. Next step: bisect.")).toBe(true);
      expect(body).toContain("- Count: 3");
      expect(body).not.toContain("- Count: 2");
    });

    it("ignores a link someone not on the triagers list wrote, and files the report anew", async () => {
      await addReport(request("quiet-heron-41"));
      // Eve may write the board, so she can link Ada's report to a Topic.
      await linkReport(idOf("quiet-heron-41"), "of:fid1:topic-alias-1", EVE);

      await triage();

      expect(verbs).toEqual(["addTopic", "linkTopic"]);
      expect(topicOf[idOf("quiet-heron-41")]).toBe("of:fid1:topic-piece-3");
      expect(topicInput.body).toBe(INPUT_1.body);
      expect(output.at(-1)).toContain(
        "1 links to a Topic were not written by a triager",
      );
    });

    it("files nothing for a sender not on the list, nor one nothing attests, and never prints their words", async () => {
      await addReport(request("quiet-heron-41"), EVE);
      await addReport(request("calm-otter-7"), null);

      await triage();

      expect(verbs).toEqual([]);
      expect(topicOf).toEqual({});
      expect(output.join("\n")).toContain(
        "2 new reports from senders not on the trusted list",
      );
      expect(output.join("\n")).not.toContain("Pat");
      expect(output.join("\n")).not.toContain("heron");
    });

    it("writes nothing on a dry run, and prints only values that pass their checks", async () => {
      await addReport(request("quiet-heron-41"));
      await addReport({
        ...request("calm-otter-7"),
        id: "not an id",
        structured: {
          source: "report",
          want: { cause: "[x](javascript:alert(1))" },
        },
      });
      await addReport({
        ...request("brave-lynx-3"),
        structured: {
          source: "report",
          want: { cause: "auth-expired", stop: "gmail-sync" },
          cfs: { release: "see www.example.com" },
        },
      });

      await triage("--dry-run");

      expect(verbs).toEqual([]);
      expect(output[0]).toContain(
        "[feedback] Weaver: auth-expired at gmail-sync",
      );
      expect(output[0]).toContain("- CFS releases: 2026.11.18");
      expect(output[0]).toContain("- Fields that failed their checks: 1");
      for (const text of ["Pat", "javascript", "example", "not an id"]) {
        expect(output[0]).not.toContain(text);
      }
    });
  });
});
