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

/** A request `send` takes, for a want stopped at gmail sync. */
function request(name: string, release = "2026.11.18"): FabricPlainObject {
  return {
    agentName: "cfs-feedback",
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
  /** The names of the reports on the board. */
  let names: string[];
  let topicOf: Record<string, string>;
  /** Who the fake `cf` writes reports as. */
  let sender: string;
  let topicInput: FabricPlainObject;

  beforeEach(async () => {
    board = await boardServer();
    dir = await Deno.makeTempDir({ prefix: "feedback-reports-tool-" });
    output = [];
    topicsOutput = [];
    stdin = undefined;
    verbs = [];
    reportIds = [];
    names = [];
    topicOf = {};
    sender = ADA;
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

  function writeReportsInput() {
    return board.write({
      "of:fid1:reports-input": {
        value: { reports: reportIds.map((id) => link(id)), topicOf },
      },
    });
  }

  /** Puts a report on the board as `author` wrote it. */
  async function addReport(
    record: FabricPlainObject,
    // `null` for a report nothing attests: no label at all.
    author: string | null = ADA,
  ) {
    const id = `of:fid1:report-${reportIds.length + 1}`;
    reportIds.push(id);
    names.push(String(record.name));
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
    verbs.push(verb);
    if (verb === "addReport") {
      if (names.includes(payload.name)) {
        return {
          code: 1,
          stdout: "",
          stderr: `Error: addReport rejected: duplicate-name: a report named ` +
            `${payload.name} is already on the board\n` +
            `invocation: ${id} phase: dispatched\n`,
        };
      }
      await addReport(payload, sender);
      return ok({ name: payload.name });
    }
    if (verb === "linkTopic") {
      topicOf = { ...topicOf, [payload.name]: payload.topic };
      await writeReportsInput();
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
    it("writes the report on stdin and answers with its name", async () => {
      stdin = JSON.stringify(request("quiet-heron-41"));

      const status = await main(["send"], deps);

      expect(status).toBe(0);
      expect(output).toEqual(['{"ok":true,"name":"quiet-heron-41"}']);
      expect(verbs).toEqual(["addReport"]);
    });

    it("answers with the board's code when the board refuses the report", async () => {
      await addReport(request("quiet-heron-41"));
      stdin = JSON.stringify(request("quiet-heron-41"));

      expect(await main(["send"], deps)).toBe(1);
      expect(JSON.parse(output[0])).toEqual({
        ok: false,
        code: "duplicate-name",
        message: "a report named quiet-heron-41 is already on the board",
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
    it("files a templated Topic for a trusted sender's report and links the report to it", async () => {
      await addReport(request("quiet-heron-41"));
      await addReport(request("calm-otter-7"));

      await main([
        "triage",
        "--trusted",
        await trustedFile(ADA),
        "--agent-name",
        "Triage",
      ], deps);

      expect(verbs).toEqual(["addTopic", "linkTopic", "linkTopic"]);
      expect(topicOf).toEqual({
        "quiet-heron-41": "of:fid1:topic-piece-3",
        "calm-otter-7": "of:fid1:topic-piece-3",
      });
      expect(topicsOutput[0]).toContain("Created top/3");
      expect(output.at(-1)).toContain("Filed 1 Topics and updated 0");
    });

    it("updates the body of the Topic a new report's problem is filed under, commenting only on a new release", async () => {
      await addReport(request("quiet-heron-41"));
      topicOf = { "quiet-heron-41": "of:fid1:topic-alias-1" };
      await writeReportsInput();
      await addReport(request("calm-otter-7"));
      const trusted = await trustedFile(ADA);
      const run = () =>
        main(["triage", "--trusted", trusted, "--agent-name", "Triage"], deps);

      await run();

      expect(verbs).toEqual(["setBody", "linkTopic"]);
      expect(topicInput.body).toContain("- Count: 2");
      expect(topicOf["calm-otter-7"]).toBe("of:fid1:topic-alias-1");

      verbs = [];
      await addReport(request("brave-lynx-3", "2026.12.01"));
      await run();

      expect(verbs).toEqual(["addComment", "setBody", "linkTopic"]);
      expect(JSON.stringify(topicInput.comments)).toContain(
        "New CFS releases: 2026.12.01.",
      );
    });

    it("files nothing for a sender not on the list, nor one nothing attests, and never prints their words", async () => {
      await addReport(request("quiet-heron-41"), EVE);
      await addReport(request("calm-otter-7"), null);

      await main([
        "triage",
        "--trusted",
        await trustedFile(ADA),
        "--agent-name",
        "Triage",
      ], deps);

      expect(verbs).toEqual([]);
      expect(topicOf).toEqual({});
      expect(output.join("\n")).toContain(
        "2 new reports from senders not on the trusted list",
      );
      expect(output.join("\n")).not.toContain("Pat");
      expect(output.join("\n")).not.toContain("heron");
    });

    it("writes nothing on a dry run, and keeps the reporter's words out of what it would file", async () => {
      await addReport(request("quiet-heron-41"));

      await main([
        "triage",
        "--trusted",
        await trustedFile(ADA),
        "--agent-name",
        "Triage",
        "--dry-run",
      ], deps);

      expect(verbs).toEqual([]);
      expect(output[0]).toContain(
        "[feedback] Weaver: auth expired, stops at gmail sync",
      );
      expect(output[0]).not.toContain("Pat");
    });
  });
});
