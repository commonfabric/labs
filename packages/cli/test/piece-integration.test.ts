/**
 * Integration tests for `cf cell get` against a live toolshed. The suite
 * runs when API_URL names a running toolshed (as in the CI cli-integration
 * jobs) and is skipped otherwise. A throwaway identity keyfile and space are
 * created per run. Run locally with:
 *   API_URL=http://localhost:8000 deno test --allow-net --allow-ffi \
 *     --allow-read --allow-write --allow-env --allow-run \
 *     test/piece-integration.test.ts
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import type { Identity } from "@commonfabric/identity";
import { experimentalOptionsForDeployedClient } from "@commonfabric/runner";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type TempIdentity,
  writeTempIdentity,
} from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  callPieceHandler,
  type EntryConfig,
  inspectPiece,
  listPieces,
  newPiece,
  type SpaceConfig,
} from "../lib/piece.ts";
import { integrationCf } from "./utils.ts";

const API_URL = Deno.env.get("API_URL");

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const NOTE_PATTERN = `${REPO_ROOT}/packages/patterns/notes/note.tsx`;
const SESSION_RESULT_PATTERN =
  `${REPO_ROOT}/packages/cli/test/fixtures/session-derived-result.tsx`;
const SESSION_SCOPED_PATTERN =
  `${REPO_ROOT}/packages/cli/test/fixtures/session-scoped-result.tsx`;

const NOTE_CONTENT = "Hello world";
const REPOSITORY = "https://github.com/commonfabric/labs";

const noteEntry: EntryConfig = {
  mainPath: NOTE_PATTERN,
  rootPath: REPO_ROOT,
  repository: REPOSITORY,
};

let pieceId = "";
let sessionResultPieceId = "";
let coldSessionResultPieceId = "";
let staleSessionResultPieceId = "";
let staleInputResultPieceId = "";
let coldSelectionResultPieceId = "";
let staleSelectionResultPieceId = "";
let sessionScopedPieceId = "";
let flags = "";
let identityPath = "";
let tempIdentity: TempIdentity | undefined;
let spaceConfig: SpaceConfig;
// The server-execution arm `cf` itself runs at (server-execution v2,
// testing.md §2): resolved exactly as the cf binary resolves it — the
// deployed-client rule (explicit EXPERIMENTAL_* env, else the server's
// published posture, else the first-party default). ON since the flip in
// the default CI lane; the explicit-`false` OFF guard lane, and a
// pre-flip toolshed, resolve OFF.
let serverExecutionOn = false;

// Resolves once the piece's result/content cell holds `expected`. Uses its
// own controller, so readiness is judged from a fresh client's view of the
// server.
async function waitForContent(
  identity: Identity,
  spaceName: string,
  piece: string,
  expected: string,
): Promise<void> {
  const pieces = await PiecesController.initialize({
    apiUrl: new URL(API_URL!),
    identity,
    space: spaceName,
  });
  try {
    const controller = await pieces.get(piece);
    const contentCell = (await controller.result.getCell())
      .asSchema<{ content?: string }>()
      .key("content");
    await contentCell.pull();
    await waitForCellValue<string>(
      pieces.runtime,
      contentCell,
      (value) => value === expected,
    );
  } finally {
    await pieces.dispose();
  }
}

/**
 * Resolves once the serving loop has derived `piece`'s `value`. Under ON a
 * served creation returns as soon as the piece is durable, and the loop
 * derives it in the cycle after; a cold read in a fresh session expects
 * that derivation, so the suite waits for it here rather than racing it.
 */
async function waitForServedValue(
  identity: Identity,
  spaceName: string,
  piece: string,
): Promise<void> {
  const pieces = await PiecesController.initialize({
    apiUrl: new URL(API_URL!),
    identity,
    space: spaceName,
  });
  try {
    const controller = await pieces.get(piece);
    const valueCell = (await controller.result.getCell())
      .asSchema<{ value?: string }>()
      .key("value");
    await valueCell.pull();
    await waitForCellValue<string>(
      pieces.runtime,
      valueCell,
      (value) => value === "session-ready",
    );
  } finally {
    await pieces.dispose();
  }
}

describe("cf cell get (integration)", { ignore: !API_URL }, () => {
  beforeAll(async () => {
    serverExecutionOn = (await experimentalOptionsForDeployedClient({
      apiUrl: new URL(API_URL!),
      env: Deno.env.get,
    })).serverExecution === true;
    tempIdentity = await writeTempIdentity();
    const { identity, path } = tempIdentity;
    identityPath = path;
    const spaceName = `cf-piece-get-test-${Date.now()}`;
    spaceConfig = {
      apiUrl: API_URL!,
      space: spaceName,
      identity: identityPath,
    };
    pieceId = await newPiece(spaceConfig, noteEntry);
    sessionResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    coldSessionResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    staleSessionResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    staleInputResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    coldSelectionResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    staleSelectionResultPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_RESULT_PATTERN,
      rootPath: REPO_ROOT,
    }, { start: false });
    // Deployed STARTED: the deploying session materializes `sessionEcho` in
    // its own session scope, which later fresh CLI sessions cannot read —
    // the lunch-poll deploy-gate shape.
    if (serverExecutionOn) {
      for (
        const cold of [
          sessionResultPieceId,
          coldSessionResultPieceId,
          coldSelectionResultPieceId,
        ]
      ) {
        await waitForServedValue(identity, spaceName, cold);
      }
    }
    sessionScopedPieceId = await newPiece(spaceConfig, {
      mainPath: SESSION_SCOPED_PATTERN,
      rootPath: REPO_ROOT,
    });
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "setTitle",
      "Integration Test Note",
    );
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "editContent",
      { detail: { value: NOTE_CONTENT } },
    );
    flags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceName} --piece ${pieceId}`;
    await waitForContent(identity, spaceName, pieceId, NOTE_CONTENT);
  });

  afterAll(async () => {
    // Ephemeral space names ensure isolation; only the throwaway identity
    // keyfile needs removing.
    await tempIdentity?.remove();
  });

  it("bad path exits 1 with Available keys: in output", async () => {
    const { code, stderr } = await integrationCf(
      `cell get ${flags} nonexistent`,
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Available keys:");
  });

  it("good path exits 0 with valid output", async () => {
    const { code, stdout } = await integrationCf(`cell get ${flags} content`);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("no path returns full result JSON", async () => {
    const { code, stdout } = await integrationCf(`cell get ${flags}`);
    expect(code).toBe(0);
    const json = JSON.parse(stdout.join(""));
    expect(typeof json).toBe("object");
    expect(json).not.toBeNull();
    expect(json.content).toBe(NOTE_CONTENT);
  });

  it("reports present result data that cannot project in a fresh session (OFF) — and serves it under the flipped default (ON)", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${sessionResultPieceId}`;
    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags}`,
    );
    if (serverExecutionOn) {
      // Under ON the refusal scenario DISSOLVES by design: the serving
      // loop materializes the session-derived result server-side
      // (derived-class commits under the space's lease), so a fresh
      // session projects the value that OFF could only report as
      // present-but-unprojectable. The strong assert is the served
      // value itself, not merely exit 0.
      expect(code).toBe(0);
      const json = JSON.parse(stdout.join(""));
      expect(json.value).toBe("session-ready");
      return;
    }
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("stored data is present");
    expect(stderr.join("\n")).toContain("--step");
  });

  it("path-less get degrades unreachable session-scoped members instead of voiding", async () => {
    // Regression pin for the lunch-poll deploy-gate bug: a fresh CLI session
    // reading a piece whose REQUIRED output lives in another session's scope
    // must get the rest of the object (exit 0), not `undefined` and not the
    // #4874 projection error. The unreachable member is simply absent.
    const scopedFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${sessionScopedPieceId}`;
    const { code, stdout, stderr } = await integrationCf(
      `cell get ${scopedFlags}`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    const json = JSON.parse(stdout.join(""));
    expect(json.stable).toBe("always-visible");
    expect("sessionEcho" in json).toBe(false);
  });

  it("steps and reads session-scoped computed results atomically", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${sessionResultPieceId}`;
    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} --step`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ value: "session-ready" });
  });

  it("steps and reads a cold session-scoped result path", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${coldSessionResultPieceId}`;
    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} value --step`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toBe("session-ready");
  });

  it("reads a current result path after changing an unstarted piece's input", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${staleSessionResultPieceId}`;
    const write = await integrationCf(
      `cell set ${sessionFlags} values --input`,
      { stdin: '["updated-while-stopped"]' },
    );
    expect(write.code, write.stderr.join("\n")).toBe(0);

    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} value --step`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toBe("updated-while-stopped");
  });

  it("steps and reads an input path of an unstarted piece", async () => {
    // The input side of the same fork: the stepped read starts the piece and
    // pulls the requested input path, without the whole-result pull. The piece
    // and the write are this test's own, because the assertion is that the
    // read returns the written value rather than the pattern's default, and a
    // value a sibling wrote is there only when that sibling also ran.
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${staleInputResultPieceId}`;
    const write = await integrationCf(
      `cell set ${sessionFlags} values --input`,
      { stdin: '["input-while-stopped"]' },
    );
    expect(write.code, write.stderr.join("\n")).toBe(0);

    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} values --input --step`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual(["input-while-stopped"]);
  });

  it("selects a cold session-scoped computed result", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${coldSelectionResultPieceId}`;
    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} --step --select value`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({ value: "session-ready" });
  });

  it("selects a current result after changing an unstarted piece's input", async () => {
    const sessionFlags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceConfig.space} --piece ${staleSelectionResultPieceId}`;
    const write = await integrationCf(
      `cell set ${sessionFlags} values --input`,
      { stdin: '["selected-while-stopped"]' },
    );
    expect(write.code, write.stderr.join("\n")).toBe(0);

    const { code, stdout, stderr } = await integrationCf(
      `cell get ${sessionFlags} --step --select value`,
    );
    expect(code, stderr.join("\n")).toBe(0);
    expect(JSON.parse(stdout.join(""))).toEqual({
      value: "selected-while-stopped",
    });
  });

  it("creates pieces through the serving loop under ON, and in the client under OFF", async () => {
    // The pieces above came from `newPiece`. Under ON the serving loop ran
    // each creation as a lifecycle verb and counts it; under OFF no serving
    // loop exists, so the health stats carry no `servingLoop` block and
    // each creation was the client's own setup transaction.
    const response = await fetch(new URL("/api/health/stats", API_URL!));
    expect(response.ok).toBe(true);
    const stats = await response.json() as {
      servingLoop?: { lifecycleVerbs?: { runs: number; failures: number } };
    };
    if (serverExecutionOn) {
      expect(stats.servingLoop?.lifecycleVerbs?.runs).toBeGreaterThanOrEqual(
        6,
      );
      return;
    }
    expect(stats.servingLoop).toBeUndefined();
  });

  it("list and inspect expose the running pattern reference", async () => {
    const listed = await listPieces(spaceConfig);
    const listedPiece = listed.find((piece) => piece.id === pieceId);
    const identity = listedPiece?.patternRef?.identity;
    expect(identity).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(listedPiece?.patternRef?.source).toEqual({
      ref: `cf:pattern:${identity}`,
      repository: REPOSITORY,
      entry: "/packages/patterns/notes/note.tsx",
    });

    const inspected = await inspectPiece({ ...spaceConfig, piece: pieceId });
    expect(inspected.patternRef).toEqual(listedPiece?.patternRef);
    expect(inspected.patternRef?.symbol).toBe("default");
  });
});
