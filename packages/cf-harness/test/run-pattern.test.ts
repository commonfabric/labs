import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCellFailClosed } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import { resolveHandleToken } from "../src/handle-table.ts";
import {
  createFabricInstantiationRecorder,
  type FabricInstantiationRecord,
  type FabricInstantiationRecorder,
  type FabricPatternInstantiations,
} from "../src/fabric-instantiations.ts";
import { comparableEntityHash } from "../src/fabric-observations.ts";
import { scrubBareFabricIdentifiers } from "../src/fabric-identifier-scrub.ts";
import { resolveWellKnownGrantRefs } from "../src/well-known-grants.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  asSerializableValue,
  policyRefusalMessage,
  RUN_PATTERN_MAX_SOURCE_TEXT_BYTES,
  runPatternPolicyRefusal,
  type RunPatternToolErrorOutput,
  type RunPatternToolInput,
  type RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type {
  CfcAddress,
  CfcRefusalDetail,
  CfcRefusalInput,
} from "@commonfabric/runner/cfc";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness run-pattern tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const NAMED_DOUBLING_PATTERN_SOURCE = [
  "import { computed, NAME, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; $NAME: string; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  [NAME]: 'Doubler',",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** A pattern whose single input is an object, for the plain-JSON cases. */
const OVERVIEW_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Overview { title: string; }",
  "interface Input { overview: Overview; }",
  "interface Output { titleLength: number; }",
  "export default pattern<Input, Output>(({ overview }) => ({",
  "  titleLength: computed(() => overview.title.length),",
  "}));",
  "",
].join("\n");

const TITLE_LENGTH_RESULT_SCHEMA = {
  type: "object",
  properties: { titleLength: { type: "number" } },
  required: ["titleLength"],
} as const;

/**
 * What a `resultSchema`-sanitized result carries at a position it sealed:
 * the single-key `@link` object over an `opaque:` target. A model reading a
 * tool result can copy one of these back out, which is what the sealed-input
 * refusal exists for.
 */
const SEALED_OPAQUE_LINK = {
  "@link": "opaque:run-pattern-test%3Arun_pattern%3A1#/overview",
} as const;

/**
 * The same seal without its `@link` wrapper. A model reading a sanitized
 * result can lift the target string out and pass it on its own, which reaches
 * an input at any position the argument schema admits a string.
 */
const SEALED_OPAQUE_TARGET = SEALED_OPAQUE_LINK["@link"];

/**
 * A pattern whose argument schema carries an index signature, so
 * `additionalProperties` is a schema: undeclared keys are permitted, and their
 * values are what that schema describes.
 */
const OPEN_DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; [key: string]: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/**
 * A pattern whose argument schema admits any undeclared key without saying
 * what it may hold, so `additionalProperties` is `true`.
 */
const ANY_DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "// deno-lint-ignore no-explicit-any",
  "interface Input { n: number; [key: string]: any; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

/** A pattern whose single input is an array, for the nested-position cases. */
const ROW_COUNT_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { rows: string[]; }",
  "interface Output { rowCount: number; }",
  "export default pattern<Input, Output>(({ rows }) => ({",
  "  rowCount: computed(() => rows.length),",
  "}));",
  "",
].join("\n");

const ROW_COUNT_RESULT_SCHEMA = {
  type: "object",
  properties: { rowCount: { type: "number" } },
  required: ["rowCount"],
} as const;

/** A pattern whose single input is a string, for the link-shaped-string case. */
const LABEL_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { label: string; }",
  "interface Output { labelLength: number; }",
  "export default pattern<Input, Output>(({ label }) => ({",
  "  labelLength: computed(() => label.length),",
  "}));",
  "",
].join("\n");

const LABEL_LENGTH_RESULT_SCHEMA = {
  type: "object",
  properties: { labelLength: { type: "number" } },
  required: ["labelLength"],
} as const;

/** A pattern whose single input is the registry array, counting its entries. */
const ENTRY_COUNT_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { entries: unknown[]; }",
  "interface Output { count: number; }",
  "export default pattern<Input, Output>(({ entries }) => ({",
  "  count: computed(() => entries.length),",
  "}));",
  "",
].join("\n");

const ENTRY_COUNT_RESULT_SCHEMA = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
} as const;

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

/**
 * A minimal default-pattern program exposing the piece registry, so the
 * space has a REAL registry rather than the detached always-empty fallback.
 */
const DEFAULT_PATTERN_SOURCE = [
  "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
  "  true,",
  "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  ");",
  "export default pattern<",
  "  { pieceRegistry: unknown[] },",
  "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
  ">(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

const EXPENSE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    amount: { type: "number" },
  },
} as const;

/**
 * A fabric session with persisted flow labels, at the enforcement posture the
 * caller names: `enforce-strict` for the tests that pin what a pattern over
 * labelled data leaves in the store and what its answer may release, and
 * `observe` for the one that pins that nothing rejects there.
 */
async function createFabric(
  cfcEnforcementMode: "observe" | "enforce-strict" = "enforce-strict",
) {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    cfcEnforcementMode,
    cfcFlowLabels: "persist",
  });
  const pieces = new PiecesController(
    await createSession({
      identity: signer,
      spaceName: `run-pattern-${cfcEnforcementMode}-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  return {
    runtime,
    pieces,
    space: pieces.getSpace(),
    dispose: async () => {
      await runtime.dispose();
      await storage.close();
    },
  };
}

const createStrictFabric = () => createFabric("enforce-strict");

/**
 * A pattern over one plain input and one optional referenced input, where the
 * referenced one only widens the answer. Run with the reference it derives
 * from labelled data; run without it, it still computes a result — which is
 * what makes dropping a refused input a replan rather than an abandonment.
 */
const OPTIONAL_SECRET_PATTERN_SOURCE = [
  "import { computed, pattern, Reactive } from 'commonfabric';",
  "interface Source { secret: string; }",
  "interface Input { amount: number; source?: Reactive<Source>; }",
  "interface Output { total: number; }",
  "export default pattern<Input, Output>(({ amount, source }) => ({",
  "  total: computed(() => {",
  "    const secret = source?.secret;",
  "    return amount + (typeof secret === 'string' ? secret.length : 0);",
  "  }),",
  "}));",
  "",
].join("\n");

const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const;

/**
 * Seeds a document whose `secret` field carries confidentiality, and answers
 * the LLM-friendly link an agent would pass as an input naming it.
 */
async function seedLabelledSecret(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  cause: string,
): Promise<string> {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    space,
    cause,
    { type: "object", properties: { secret: { type: "string" } } },
    seed,
  );
  const sourceId = sourceCell.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id: sourceId, path: [] }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{ path: ["secret"], label: { confidentiality: ["secret"] } }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
  return createLLMFriendlyLink(sourceCell.getAsNormalizedFullLink(), space);
}

/**
 * A pattern over an operator-shaped account: a balance and a list of
 * transactions, the spending summed from the negative amounts. The input is
 * typed as plain data, which is how a model wires a cell it was handed.
 */
const SPENDING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Transaction { amount: number; }",
  "interface Account { balance: number; transactions: Transaction[]; }",
  "interface Input { account: Account; }",
  "interface Output { totalSpending: number; }",
  "export default pattern<Input, Output>(({ account }) => ({",
  "  totalSpending: computed(() => account.transactions.reduce(",
  "    (sum, t) => sum + (t.amount < 0 ? -t.amount : 0),",
  "    0,",
  "  )),",
  "}));",
  "",
].join("\n");

const TOTAL_SPENDING_RESULT_SCHEMA = {
  type: "object",
  properties: { totalSpending: { type: "number" } },
  required: ["totalSpending"],
} as const;

/**
 * How the holder document an agent is handed reaches the labeled account:
 * through a link in its `account` field, the way an operator attaches one;
 * through a link at its own root, above the field the agent addresses; or
 * through its `account` field beside a `notes` field linking to an
 * unlabeled document, so a dereference the holder records leads somewhere
 * the account never goes.
 */
type AccountHolderShape = "field-link" | "root-link" | "two-fields";

/**
 * Seeds an account the way an operator attaches one: a holder document that
 * reaches the account document by a link, with the confidentiality on the
 * account document and not on the holder. Returns the LLM-friendly link to
 * the holder's `account` position, which is what the agent is handed — so
 * the labeled document is one the agent's address never names, reached only
 * by dereferencing what the holder holds — and, for the two-field shape, the
 * link to its `notes` position as well.
 */
async function seedAccountHolder(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  cause: string,
  shape: AccountHolderShape,
): Promise<{ account: string; notes: string }> {
  const seed = runtime.edit();
  const account = {
    balance: 2000,
    transactions: [{ amount: -120 }, { amount: 2000 }, { amount: -25 }],
  };
  const accountCell = runtime.getCell(
    space,
    `${cause}-account`,
    undefined,
    seed,
  );
  const accountId = accountCell.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  // A root-linked holder continues into the account document at `account`,
  // so that document carries the field and the label sits on it; the others
  // link straight at the account, labeled at its root.
  seedStoredEnvelope(seed, { space, scope: "space", id: accountId, path: [] }, {
    value: shape === "root-link" ? { account } : account,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: shape === "root-link" ? ["account"] : [],
          label: { confidentiality: ["finance"] },
        }],
      },
    },
  });
  const notesCell = runtime.getCell(space, `${cause}-notes`, undefined, seed);
  const notesId = notesCell.getAsNormalizedFullLink().id;
  seed.writeOrThrow({ space, scope: "space", id: notesId, path: [] }, {
    value: { text: "unlabeled" },
  });
  const linkTo = (id: string) => ({
    "/": { "link@1": { id, path: [], scope: "space", space } },
  });
  const holderCell = runtime.getCell(space, `${cause}-holder`, undefined, seed);
  seed.writeOrThrow(
    {
      space,
      scope: "space",
      id: holderCell.getAsNormalizedFullLink().id,
      path: [],
    },
    {
      value: shape === "root-link"
        ? linkTo(accountId)
        : shape === "two-fields"
        ? { account: linkTo(accountId), notes: linkTo(notesId) }
        : { account: linkTo(accountId) },
    },
  );
  expect((await seed.commit()).ok).toBeDefined();
  return {
    account: createLLMFriendlyLink(
      holderCell.key("account").getAsNormalizedFullLink(),
      space,
    ),
    notes: createLLMFriendlyLink(
      holderCell.key("notes").getAsNormalizedFullLink(),
      space,
    ),
  };
}

/** {@link seedAccountHolder} in the operator's shape, the account link alone. */
async function seedLabelledAccount(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  cause: string,
): Promise<string> {
  return (await seedAccountHolder(runtime, space, cause, "field-link")).account;
}

/**
 * The session's pieces with the argument-document route to an input key taken
 * away: once the piece is running, resolving its argument cell fails. That is
 * the state a refusal report degrades under when the argument cell of a piece
 * that ran will not resolve, and the caller's own resolved addresses are all
 * that is left to answer with.
 */
function piecesWithUnresolvableArgument(
  pieces: PiecesController,
): PiecesController {
  let running = false;
  return new Proxy(pieces, {
    get(target, property) {
      if (property === "runPersistent") {
        return async (
          ...args: Parameters<PiecesController["runPersistent"]>
        ) => {
          const cell = await target.runPersistent(...args);
          running = true;
          return cell;
        };
      }
      if (property === "getArgument") {
        return (...args: Parameters<PiecesController["getArgument"]>) => {
          if (running) {
            throw new Error("the piece's argument cell does not resolve");
          }
          return target.getArgument(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The space a synthetic refusal detail addresses; never resolved. */
const REFUSAL_SPACE = "did:key:zRunPatternRefusal" as const;

/**
 * A read of `id` at `path`, as a refusal detail addresses one. The id is a
 * plain string rather than an `of:` URI, which the canonical entity-id seam
 * passes through unchanged, so two details naming one id compare as one
 * document.
 */
function refusalRead(id: string, path: readonly string[] = []): CfcAddress {
  return { space: REFUSAL_SPACE, id, scope: "space", path: [...path] };
}

/** One read that carried `"secret"` into a refused operation. */
function refusalInput(
  id: string,
  labelPath: readonly string[] = ["secret"],
): CfcRefusalInput {
  return { read: refusalRead(id), labelPath, atoms: ['"secret"'] };
}

/** A `writer-fit` refusal over one named read, with `overrides` applied. */
function refusalDetail(
  overrides: Partial<CfcRefusalDetail> = {},
): CfcRefusalDetail {
  return {
    gate: "writer-fit",
    offendingAtoms: ['"secret"'],
    inputs: [],
    attribution: "complete",
    reason: "CFC enforcement rejected commit",
    ...overrides,
  };
}

/** Resolves a refused read to an input key by the document it names. */
function inputKeysByDocument(
  owned: Readonly<Record<string, string | string[]>>,
): (read: CfcAddress) => readonly string[] {
  return (read) => {
    const keys = owned[read.id];
    return keys === undefined ? [] : typeof keys === "string" ? [keys] : keys;
  };
}

/**
 * Seeds the same labelled document as {@link seedLabelledSecret} under a
 * COMPUTED entity id, and answers the link an agent would pass naming it. A
 * kinded id names a different entity from the `of:` id over the same hash, so
 * the canonical entity-id seam refuses to reduce it and nothing that compares
 * documents by hash can place a read of one.
 */
async function seedLabelledComputedSecret(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  cause: string,
): Promise<string> {
  const seed = runtime.edit();
  const plainId = runtime.getCell(space, cause, undefined, seed)
    .getAsNormalizedFullLink().id;
  const computedId: `${string}:${string}` = `computed:${
    plainId.slice("of:".length)
  }`;
  const sourceCell = runtime.getCellFromLink(
    { id: computedId, path: [], space, scope: "space" },
    { type: "object", properties: { secret: { type: "string" } } },
    seed,
  );
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(
    seed,
    { space, scope: "space", id: computedId, path: [] },
    {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["secret"],
            label: { confidentiality: ["secret"] },
          }],
        },
      },
    },
  );
  expect((await seed.commit()).ok).toBeDefined();
  return createLLMFriendlyLink(sourceCell.getAsNormalizedFullLink(), space);
}

function createStrictEngine(pieces: PiecesController): CfHarnessEngine {
  return new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `run-pattern-strict-${crypto.randomUUID()}`,
    fabricSessionFactory: () => Promise.resolve({ pieces }),
  });
}

/**
 * The ids of the stored documents reachable from `rootId` whose stored form
 * (value and metadata alike) contains `needle`, in traversal order. Documents
 * are walked breadth-first through every id-shaped string in their stored
 * form, so a value held only behind links is attributed to the document that
 * actually stores it.
 */
function docsHolding(
  runtime: Runtime,
  space: ReturnType<PiecesController["getSpace"]>,
  rootId: string,
  needle: string,
): string[] {
  const holding: string[] = [];
  const pending: `${string}:${string}`[] = [rootId as `${string}:${string}`];
  const seen = new Set(pending);
  const verify = runtime.edit();
  try {
    while (pending.length > 0) {
      const id = pending.shift()!;
      let stored: unknown;
      try {
        stored = verify.readOrThrow({ space, scope: "space", id, path: [] });
      } catch {
        continue;
      }
      const serialized = JSON.stringify(stored);
      if (serialized === undefined) continue;
      if (serialized.includes(needle)) holding.push(id);
      for (
        const [quoted] of serialized.matchAll(
          /"((?:of|data|computed|raw|stream):[^"]+)"/g,
        )
      ) {
        const next = JSON.parse(quoted) as `${string}:${string}`;
        if (!seen.has(next)) {
          seen.add(next);
          pending.push(next);
        }
      }
    }
  } finally {
    verify.abort();
  }
  return holding;
}

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const STRANDED_ENTITY =
  "of:fid1:Lu5lEvAZXeeCOI6SprXO9EG6gDFeZbLWP-MexaaM_qc" as const;

const STRANDED_RECORDS: readonly FabricInstantiationRecord[] = [{
  sequence: 1,
  identity: "keyless:zStranded",
  symbol: "default",
  cell: comparableEntityHash(STRANDED_ENTITY)!,
  link: {
    id: STRANDED_ENTITY,
    space: signer.did(),
    scope: "space",
    path: [],
  },
}];

describe("run-pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let recorder: FabricInstantiationRecorder;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    recorder = createFabricInstantiationRecorder();
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      onPatternInstantiated: recorder.observe,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function createEngine(
    instantiations: FabricPatternInstantiations = recorder.instantiations,
  ) {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-test-${crypto.randomUUID()}`,
      fabricSessionFactory: () => Promise.resolve({ pieces, instantiations }),
    });
  }

  /** Counts `runPersistent` calls, the single path that persists a piece. */
  function spyOnRunPersistent(): { calls: number } {
    const spy = { calls: 0 };
    const original = pieces.runPersistent.bind(pieces);
    pieces.runPersistent = ((
      ...args: Parameters<
        PiecesController["runPersistent"]
      >
    ) => {
      spy.calls += 1;
      return original(...args);
    }) as PiecesController["runPersistent"];
    return spy;
  }

  describe("runPatternTool", () => {
    it("runs inline `sourceText` and returns a `resultRef` with the sanitized `value`", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.resultRef).toMatch(/^\/of:/);
      expect(output.pieceId.length).toBeGreaterThan(0);
      expect((output.value as { doubled: number }).doubled).toBe(42);
      expect(output.linkedStringCount).toBe(0);
    });

    it("runs a pattern whose internal state feeds computed result fields, which strands nothing", async () => {
      // The result is an object literal, so the piece's own root is the
      // compiled pattern's: every instantiation this run reports is
      // content-addressed, and the guard has nothing to claim.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { cell, computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { doubled: number; }",
          "export default pattern<Input, Output>(({ n }) => {",
          "  const factor = cell(2);",
          "  return { doubled: computed(() => n * factor.get()) };",
          "});",
          "",
        ].join("\n"),
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);
      const recorded = recorder.instantiations.since(0);
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.some((one) => one.identity.startsWith("keyless:"))).toBe(
        false,
      );
    });

    it("answers over an instance whose result will not read back", async () => {
      // The disclosure reads every pattern the run materialized, and one it
      // cannot read says nothing about the others or about the run. A cell
      // whose pull rejects is what a torn-down instance and a store that
      // stopped answering both look like from inside the scan.
      const pristineFromLink = runtime.getCellFromLink.bind(runtime);
      const runtimeWithLink = runtime as unknown as {
        getCellFromLink: typeof pristineFromLink;
      };
      let settled = false;
      // Counted, because every assertion below also holds for a scan that
      // read every instance cleanly: what says the failure path ran is that
      // it ran, not that the run came back.
      let refusedReads = 0;
      // `withTx` answers a cell of its own, and the scan pulls THAT one, so
      // the refusal has to follow the cell across it rather than sit on the
      // one the link produced.
      const refusingRead = <T>(cell: T): T =>
        new Proxy(cell as object, {
          get: (target, property, receiver) => {
            if (property === "pull") {
              return () => {
                refusedReads += 1;
                return Promise.reject(
                  new Error("the store stopped answering"),
                );
              };
            }
            const member = Reflect.get(target, property, receiver);
            if (property === "withTx" && typeof member === "function") {
              return (...args: unknown[]) =>
                refusingRead((member as (...a: unknown[]) => unknown).apply(
                  target,
                  args,
                ));
            }
            return member;
          },
        }) as T;
      runtimeWithLink.getCellFromLink = ((
        ...args: Parameters<typeof pristineFromLink>
      ) => {
        const cell = pristineFromLink(...args);
        return settled ? refusingRead(cell) : cell;
      }) as typeof pristineFromLink;
      const syncedBefore = pieces.synced.bind(pieces);
      (pieces as unknown as { synced: () => Promise<void> }).synced =
        async () => {
          await syncedBefore();
          settled = true;
        };

      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;

      expect(refusedReads).toBeGreaterThan(0);
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);
      expect(output.outputConcerns).toBeUndefined();
    });

    it("fails the run when the invocation materialized a session-only pointer", async () => {
      // What the runner reports for a root no stored artifact names: a
      // `keyless:` pointer stamped somewhere in the created piece's graph.
      const stranded: FabricPatternInstantiations = {
        sequence: () => 0,
        since: () => STRANDED_RECORDS,
        keylessSince: () => STRANDED_RECORDS,
      };
      const result = await createEngine(stranded).invokeBuiltinTool(
        "run_pattern",
        { sourceText: DOUBLING_PATTERN_SOURCE, inputs: { n: 21 } },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("detected");
      expect(output.message).toContain("session-only pattern pointer");
      expect(output.message).not.toContain("computed()");
      expect(output.message).not.toContain("keyless:zStranded");
      expect(output.rawCauseMessage).toContain("keyless:zStranded");
    });

    it("returns a result when the session reports no instantiations at all", async () => {
      // A session built without an instantiation recorder answers no question
      // about pattern pointers, and the run proceeds on the rest.
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () => Promise.resolve({ pieces }),
      });
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);
    });

    it("returns a sealed string position as the address of that position rather than an opaque link", async () => {
      // The schema declares `label` as an unconstrained string, which the
      // sanitizer withholds as text. The result is fabric-backed, so the
      // withheld position goes over as a whole `@link` object addressing it
      // — resultRef plus the sealed path — which the outbound swap mints
      // into a token in one piece, whitespace in property names and all. Foreign seals are a different thing and stay
      // refused at input; only seals this sanitization minted are addressed.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { doubled: number; label: string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  doubled: computed(() => n * 2),",
          "  label: computed(() => `doubled ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 21 },
        resultSchema: {
          type: "object",
          properties: {
            doubled: { type: "number" },
            label: { type: "string" },
          },
          required: ["doubled", "label"],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      const value = output.value as { doubled: number; label: string };
      expect(value.doubled).toBe(42);
      expect(value.label).toEqual({ "@link": `${output.resultRef}/label` });
      expect(output.linkedStringCount).toBe(1);
    });

    it("addresses a sealed property whose name carries whitespace without truncating the path", async () => {
      // "full name" is a valid JSON key the free-text scanner would cut an
      // address short at; the whole `@link` object keeps it in one piece.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { 'full name': string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  'full name': computed(() => `holder ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 3 },
        resultSchema: {
          type: "object",
          properties: { "full name": { type: "string" } },
          required: ["full name"],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as Record<string, unknown>)["full name"]).toEqual({
        "@link": `${output.resultRef}/full name`,
      });
    });

    it("addresses an empty property with a trailing slash", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Input { n: number; }",
          "interface Output { '': string; }",
          "export default pattern<Input, Output>(({ n }) => ({",
          "  '': computed(() => `anon ${n}`),",
          "}));",
          "",
        ].join("\n"),
        inputs: { n: 5 },
        resultSchema: {
          type: "object",
          properties: { "": { type: "string" } },
          required: [""],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as Record<string, unknown>)[""]).toEqual({
        "@link": `${output.resultRef}/`,
      });
    });

    it("returns a structured error for a plain-function pattern whose compiled argument schema is undefined, rather than throwing out of the run", async () => {
      const engine = createEngine();
      // A bare default function compiles to a pattern with no argument
      // schema at all — not even the boolean schema `pattern()` synthesizes
      // — so the undeclared-input check must not assume one exists. The
      // source itself is not a runnable pattern; what this pins is that its
      // failure comes back as a tool output the model can read and correct.
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          'export const NAME = "Probe";',
          "export default function({}: {}) { return { ok: true }; }",
          "",
        ].join("\n"),
      });
      const output = result.output as { status: string; message?: string };
      expect(output.status).toBe("error");
      expect((output.message ?? "").length).toBeGreaterThan(0);
    });

    it("keeps a computed number when the result carries framework keys the schema does not declare", async () => {
      // Every pattern result carries the framework's own keys, and a schema
      // describing only what the pattern computes declares none of them. The
      // sanitizer seals a whole object over one unmodeled key, so without the
      // framework keys being dropped first the number goes over as an opaque
      // link along with everything else.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.rawValue as Record<string, unknown>)["$NAME"]).toBe(
        "Doubler",
      );
      expect(output.value).toEqual({ doubled: 42 });
      expect(output.linkedStringCount).toBe(0);
    });

    it("refuses a result the schema rejects for what it carries under a framework key", async () => {
      // The raw result is what the schema measures. A branch that asks what
      // `$NAME` holds gets the answer the pattern gave, so a result that does
      // not match is refused — projecting the framework keys out before
      // validating would hand the branch the rest of the result and accept it.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Approved" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toBeUndefined();
      expect(output.valueError).toBeDefined();
    });

    it("keeps a framework key the schema declares through a composed branch", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Doubler" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42, $NAME: "Doubler" });
    });

    it("passes a whole-string LLM-friendly link input as a live cell reference", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell<number>(space, "run-pattern-seed", {
        type: "number",
      });
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(7);
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(14);
    });

    it("stores a by-reference input as a link, so the created piece's argument follows the referenced cell", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell<number>(space, "run-pattern-wired-seed", {
        type: "number",
      });
      const seeded = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(7);
      });
      expect(seeded.error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");

      // The created piece's argument reads back as the referenced cell's
      // value, at the key the pattern declares.
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["n"])).toBe(7);

      // And it holds the reference rather than a copy of what the reference
      // pointed at when the piece was created: a later write to the seed
      // reaches the piece's result.
      const rewritten = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(10);
      });
      expect(rewritten.error).toBeUndefined();
      await runtime.idle();
      await pieces.synced();
      expect(await piece.result.get(["doubled"])).toBe(20);
    });

    it("returns an error naming the failing computation when the result settles to nothing", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Output { boom: number; }",
          "export default pattern<Record<string, never>, Output>(() => ({",
          "  boom: computed(() => { throw new Error('boom in lift'); }),",
          "}));",
          "",
        ].join("\n"),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while settling");
      // The thrown text is a data channel: it stays in the artifact field the
      // prompt loop strips from model context, never in the message.
      expect(output.message).not.toContain("boom in lift");
      expect(output.rawCauseMessage).toContain("boom in lift");
      expect(output.pieceId).toBeDefined();
      expect(result.runState.status).not.toBe("failed");
    });

    it("reports a commit the boundary refused as a refusal, not as a thrown computation", async () => {
      // The two exits share a guard — a piece whose result never landed — and
      // are told apart only by the error's name, so a refusal reported as a
      // thrown computation would carry the wrong message and lose its
      // structured refusals. A pattern this PR's ownership route cannot get
      // refused any more (every store such a run writes is one the runtime
      // owns), so the record is raised by name here rather than by provoking
      // the boundary: what is under test is which exit the tool takes and
      // what it puts in the model-facing message, both of which read the name
      // and nothing else about how the record arrived.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Output { boom: number; }",
          "export default pattern<Record<string, never>, Output>(() => ({",
          "  boom: computed(() => {",
          "    const refusal = new Error('refused: /of:doc at //x');",
          "    refusal.name = 'CfcCommitRefusalError';",
          "    throw refusal;",
          "  }),",
          "}));",
          "",
        ].join("\n"),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("policy refused to commit");
      expect(output.message).not.toContain("failed while settling");
      // A refusal the boundary described only in prose carries no structured
      // refusals, so the message is the opaque one and the detail stays in
      // the artifact field the prompt loop strips from model context.
      expect(output.message).not.toContain("of:doc");
      expect(output.rawCauseMessage).toContain("of:doc");
      expect(output.pieceId).toBeDefined();
      // The decision the run's policy trace carries: the commit boundary
      // refused, and it states no sink or ceiling of its own, since the
      // runner refused at the pattern's own sink requests.
      expect(output.releaseDecision).toEqual({
        reasonCode: "cfc_commit_refused",
        boundary: "commit",
      });
    });

    it("names the clause and the gate when the refused commit carried structured refusals", async () => {
      // The other arm of the same exit: a refusal the boundary described
      // structurally gets the described message rather than the opaque one,
      // and the atoms reach the model while the documents do not.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: [
          "import { computed, pattern } from 'commonfabric';",
          "interface Output { boom: number; }",
          "export default pattern<Record<string, never>, Output>(() => ({",
          "  boom: computed(() => {",
          "    const refusal = new Error('refused: /of:ledger at //total') as",
          "      Error & { refusals?: unknown[] };",
          "    refusal.name = 'CfcCommitRefusalError';",
          "    refusal.refusals = [{",
          "      gate: 'writer-fit',",
          "      offendingAtoms: ['\"expense-note\"'],",
          "      inputs: [],",
          "      attribution: 'none',",
          "      reason: 'writer-fit confidentiality misfit',",
          "    }];",
          "    throw refusal;",
          "  }),",
          "}));",
          "",
        ].join("\n"),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("policy refused to commit");
      expect(output.message).toContain("expense-note");
      expect(output.policyRefusal).toBeDefined();
      // Document identifiers stay out of the model-facing message either way.
      expect(output.message).not.toContain("of:ledger");
      expect(output.rawCauseMessage).toContain("of:ledger");
      expect(output.releaseDecision?.reasonCode).toBe("cfc_commit_refused");
      expect(output.releaseDecision?.refusal).toEqual(output.policyRefusal);
    });

    it("returns an error naming the policy refusal when the answer carries a label the model may not read", async () => {
      // A strict flow-label runtime over a labelled source: the pattern
      // derives from the secret, and its result carries the secret's label.
      // The answer is an egress, so the tool measures what it would release
      // and refuses, with the reason (which names the labels and documents
      // involved) kept in the artifact channel rather than the model-facing
      // message.
      const strictStorage = StorageManager.emulate({ as: signer });
      const strictRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: strictStorage,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      const strictPieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `run-pattern-strict-${crypto.randomUUID()}`,
        }),
        strictRuntime,
      );
      try {
        await strictPieces.synced();
        const space = strictPieces.getSpace();
        const seed = strictRuntime.edit();
        const sourceCell = strictRuntime.getCell(
          space,
          "labelled-source",
          {
            type: "object",
            properties: {
              secret: { type: "string" },
              amount: { type: "number" },
            },
          },
          seed,
        );
        const sourceId = sourceCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, {
          space,
          scope: "space",
          id: sourceId,
          path: [],
        }, {
          value: { secret: "s3cr3t", amount: 2 },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: ["secret"],
                label: { confidentiality: ["secret"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();
        const sourceRef = createLLMFriendlyLink(
          sourceCell.getAsNormalizedFullLink(),
          space,
        );

        const engine = new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: `run-pattern-strict-${crypto.randomUUID()}`,
          fabricSessionFactory: () => Promise.resolve({ pieces: strictPieces }),
        });
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: [
            "import { computed, pattern, Reactive } from 'commonfabric';",
            "interface Source { secret: string; amount: number; }",
            "interface Input { source: Reactive<Source>; }",
            "interface Output { copied: string; }",
            "export default pattern<Input, Output>(({ source }) => ({",
            "  copied: computed(() => `${source.secret}!`),",
            "}));",
            "",
          ].join("\n"),
          inputs: { source: sourceRef },
          resultSchema: {
            type: "object",
            properties: { copied: { type: "string" } },
            required: ["copied"],
          },
        });
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.valueError).toContain("policy refused to release");
        expect(output.valueError).toContain("withheld here");
        // The refusal reason is a data channel: it stays in the artifact
        // field the prompt loop strips from model context, never in the
        // model-facing text.
        expect(output.valueError).not.toContain("exceeds ceiling");
        expect(output.rawCauseMessage).toContain(
          'confidentiality exceeds ceiling for run_pattern: "secret"',
        );
        expect(output.pieceId).toBeDefined();
      } finally {
        await strictRuntime.dispose();
        await strictStorage.close();
      }
    });

    it("names the input key that carried the refused label, in the message and in `policyRefusal`", async () => {
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "refusal-names-input",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
            inputs: { amount: 2, source: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.valueError).toContain("policy refused to release");
        expect(output.valueError).toContain('input "source"');
        expect(output.valueError).toContain("without it releases its values");
        expect(output.valueError).not.toContain('"amount"');
        expect(output.policyRefusal).toEqual({
          gates: ["sink-ceiling"],
          sinks: ["run_pattern"],
          offendingAtoms: ['"secret"'],
          inputKeys: ["source"],
          attribution: "complete",
        });
      } finally {
        await dispose();
      }
    });

    it("lands a result when the run is repeated without the input its refusal named", async () => {
      // The replan an actionable refusal is for: the first run is refused
      // and names one of its own input keys as the whole remedy, and the
      // second run — the same pattern, that key dropped — commits.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "refusal-replan",
        );
        const engine = createStrictEngine(pieces);
        const inputs: Record<string, unknown> = {
          amount: 2,
          source: sourceRef,
        };
        const refused = (await engine.invokeBuiltinTool("run_pattern", {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs,
          resultSchema: TOTAL_RESULT_SCHEMA,
        })).output as RunPatternToolSuccessOutput;
        expect(refused.status).toBe("ok");
        expect(refused.value).toBeUndefined();
        expect(refused.policyRefusal?.attribution).toBe("complete");
        const named = refused.policyRefusal?.inputKeys ?? [];
        expect(named).toEqual(["source"]);

        // Drop exactly the keys the refusal named, changing nothing else.
        const replanned: Record<string, unknown> = { ...inputs };
        for (const key of named) delete replanned[key];
        const retried = (await engine.invokeBuiltinTool("run_pattern", {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs: replanned,
          resultSchema: TOTAL_RESULT_SCHEMA,
        })).output as RunPatternToolSuccessOutput;
        expect(retried.status).toBe("ok");
        expect((retried.value as { total: number }).total).toBe(2);
      } finally {
        await dispose();
      }
    });

    it("leaves `policyRefusal` unchanged under the bare-fabric-identifier scrub", async () => {
      // `policyRefusal` reaches the model as it stands — the prompt loop
      // scrubs `message` and `valueError` and nothing else — so it must
      // already hold no document id, space, or path into a document.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "refusal-carries-no-identifier",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
            inputs: { amount: 2, source: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        const encoded = JSON.stringify(output.policyRefusal);
        expect(scrubBareFabricIdentifiers(encoded)).toBe(encoded);
        expect(encoded).not.toContain(space);
      } finally {
        await dispose();
      }
    });

    it("refuses an answer whose label sits on a field of the document it passes through", async () => {
      // Resolving a value reads the links it holds; a label on a field is
      // consumed where that field is read. This answer is the labelled
      // document itself, passed through by reference, and its label sits one
      // level down — so the measurement has to walk what it releases.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-field-label",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { pattern, Reactive } from 'commonfabric';",
              "interface Source { secret: string; }",
              "interface Input { source: Reactive<Source>; }",
              "interface Output { copy: Reactive<Source>; }",
              "export default pattern<Input, Output>(({ source }) => ({",
              "  copy: source,",
              "}));",
              "",
            ].join("\n"),
            inputs: { source: sourceRef },
            resultSchema: {
              type: "object",
              properties: {
                copy: {
                  type: "object",
                  properties: { secret: { type: "string" } },
                },
              },
              required: ["copy"],
            },
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.valueError).toContain("policy refused to release");
        expect(output.policyRefusal?.offendingAtoms).toEqual(['"secret"']);
      } finally {
        await dispose();
      }
    });

    it("names both keys when one labelled document is supplied under two", async () => {
      // The remedy has to name every alias: dropping one of them leaves the
      // other handing the same document to the pattern. With the argument
      // document gone, one read of the shared document is all there is to
      // trace, and both aliases resolve from the addresses the caller's own
      // links reached.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-aliased-input",
        );
        const result = await createStrictEngine(
          piecesWithUnresolvableArgument(pieces),
        ).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { computed, pattern, Reactive } from 'commonfabric';",
              "interface Source { secret: string; }",
              "interface Input {",
              "  amount: number;",
              "  source?: Reactive<Source>;",
              "  alsoSource?: Reactive<Source>;",
              "}",
              "interface Output { total: number; }",
              "export default pattern<Input, Output>(({ amount, source }) => ({",
              "  total: computed(() => {",
              "    const secret = source?.secret;",
              "    return amount + (typeof secret === 'string'",
              "      ? secret.length",
              "      : 0);",
              "  }),",
              "}));",
              "",
            ].join("\n"),
            inputs: { amount: 2, source: sourceRef, alsoSource: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal?.inputKeys).toEqual(
          expect.arrayContaining(["source", "alsoSource"]),
        );
      } finally {
        await dispose();
      }
    });

    it("refuses an answer whose label is two links down", async () => {
      // The leaf the answer carries sits inside a nested object, behind a
      // computed cell, behind the result document. Resolving the result is
      // not the same as reading what it resolves to, so this is what says
      // the measurement reaches the whole answer rather than its first hop.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-nested-label",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { computed, pattern, Reactive } from 'commonfabric';",
              "interface Source { secret: string; }",
              "interface Input { source: Reactive<Source>; }",
              "interface Output { wrapper: { note: string } }",
              "export default pattern<Input, Output>(({ source }) => ({",
              "  wrapper: { note: computed(() => `${source.secret}!`) },",
              "}));",
              "",
            ].join("\n"),
            inputs: { source: sourceRef },
            resultSchema: {
              type: "object",
              properties: {
                wrapper: {
                  type: "object",
                  properties: { note: { type: "string" } },
                },
              },
              required: ["wrapper"],
            },
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.valueError).toContain("policy refused to release");
        expect(output.policyRefusal?.offendingAtoms).toEqual(['"secret"']);
      } finally {
        await dispose();
      }
    });

    it("answers at the observe posture, where no gate rejects", async () => {
      // The enforcement ladder decides whether a recorded reason rejects, and
      // at `observe` none of them do. The answer carries the label either
      // way; what changes is that nothing refuses over it.
      const { runtime, pieces, space, dispose } = await createFabric("observe");
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-observe",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
            inputs: { amount: 2, source: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect((output.value as { total: number }).total).toBe(8);
        // Nothing rejects here, and the measurement still ran: what raising
        // the rung would refuse is recorded for whoever is staging it.
        expect(output.releaseObservation?.offendingAtoms).toEqual(['"secret"']);
        expect(output.releaseObservation?.inputKeys).toEqual(["source"]);
        // The measurement said as a decision: it did not reject, and it
        // carries the same attribution the observation does.
        expect(output.releaseDecision).toEqual({
          reasonCode: "cfc_release_observed",
          boundary: "release",
          sink: "run_pattern",
          ceiling: [],
          refusal: output.releaseObservation,
        });
      } finally {
        await dispose();
      }
    });

    it("answers when a labelled input reaches the argument document and not the result", async () => {
      // What the answer carries is what releasing it resolves, not what the
      // caller handed over. This pattern names the labelled input and never
      // reads it, so the total it returns derives from the plain one alone.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-unread-input",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { computed, pattern, Reactive } from 'commonfabric';",
              "interface Source { secret: string; }",
              "interface Input { amount: number; source?: Reactive<Source>; }",
              "interface Output { total: number; }",
              "export default pattern<Input, Output>(({ amount }) => ({",
              "  total: computed(() => amount + 1),",
              "}));",
              "",
            ].join("\n"),
            inputs: { amount: 2, source: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect((output.value as { total: number }).total).toBe(3);
        // The boundary ran and admitted the flow, which the trace records as
        // readily as a refusal: an operator reading only refusals cannot tell
        // a gate that passed from one that never ran.
        expect(output.releaseDecision).toEqual({
          reasonCode: "cfc_release_allowed",
          boundary: "release",
          sink: "run_pattern",
          ceiling: [],
        });
      } finally {
        await dispose();
      }
    });

    it("names the input from the caller's own addresses when the piece's argument cell will not resolve", async () => {
      // The argument document is one of the two routes from a released clause
      // back to an input key. With it gone the report stands on the addresses
      // the caller's own links resolved to, which account for this clause on
      // their own.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "refusal-without-argument-route",
        );
        const result = await createStrictEngine(
          piecesWithUnresolvableArgument(pieces),
        ).invokeBuiltinTool("run_pattern", {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs: { amount: 2, source: sourceRef },
          resultSchema: TOTAL_RESULT_SCHEMA,
        });
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal?.inputKeys).toEqual(["source"]);
        expect(output.policyRefusal?.attribution).toBe("complete");
        expect(output.valueError).toContain("without it releases its values");
      } finally {
        await dispose();
      }
    });

    it("counts a refused read of a computed document, whose kinded id no input address can be compared against", async () => {
      // A kinded entity id does not reduce to a hash, so neither route from a
      // refused read to an input key can place it. The report counts it
      // instead of guessing, and drops to `partial`.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledComputedSecret(
          runtime,
          space,
          "refusal-over-computed-source",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
            inputs: { amount: 2, source: sourceRef },
            resultSchema: TOTAL_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal?.unattributedInputCount).toBe(1);
      } finally {
        await dispose();
      }
    });

    it("returns the result reference without consulting the ceiling when no `resultSchema` asks for values", async () => {
      // A reference names the result without carrying it, so handing one
      // back discloses nothing: the ceiling gates values, and a call that
      // asks for none is not measured against it. This is the shape an
      // agent that routes data it never reads relies on — the pattern
      // derives from a labeled input, and the reference to what it derived
      // comes back all the same.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const accountRef = await seedLabelledAccount(
          runtime,
          space,
          "release-reference-only",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: SPENDING_PATTERN_SOURCE,
            inputs: { account: accountRef },
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.resultRef).toMatch(/^\/of:/);
        expect(output.value).toBeUndefined();
        expect(output.valueError).toBeUndefined();
        expect(output.policyRefusal).toBeUndefined();
        expect(output.releaseObservation).toBeUndefined();
        // Nothing was measured, so the trace records no decision about a
        // boundary this call never reached.
        expect(output.releaseDecision).toBeUndefined();
        // The result did derive from the labeled input: the reference names
        // exactly what the ceiling withholds as a value.
        expect((output.rawValue as { totalSpending: number }).totalSpending)
          .toBe(145);
      } finally {
        await dispose();
      }
    });

    it("withholds the values the ceiling refuses and still returns the result reference", async () => {
      // Asking for values is what consults the ceiling, and a refusal
      // withholds exactly what was measured: the values. The reference comes
      // back with them withheld, so the agent can still pass the result on
      // by reference, and the refusal reaches it as data and as an
      // instruction while the reason stays in the artifact.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const accountRef = await seedLabelledAccount(
          runtime,
          space,
          "release-values-withheld",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: SPENDING_PATTERN_SOURCE,
            inputs: { account: accountRef },
            resultSchema: TOTAL_SPENDING_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.resultRef).toMatch(/^\/of:/);
        expect(output.value).toBeUndefined();
        expect(output.linkedStringCount).toBeUndefined();
        expect(output.valueError).toContain(
          "policy refused to release its values",
        );
        expect(output.valueError).toContain("resultRef still names the result");
        expect(output.valueError).not.toContain("exceeds ceiling");
        expect(output.rawCauseMessage).toContain(
          'confidentiality exceeds ceiling for run_pattern: "finance"',
        );
        expect(output.policyRefusal?.gates).toEqual(["sink-ceiling"]);
        expect(output.policyRefusal?.offendingAtoms).toEqual(['"finance"']);
        expect(output.releaseDecision).toEqual({
          reasonCode: "cfc_release_withheld",
          boundary: "release",
          sink: "run_pattern",
          ceiling: [],
          refusal: output.policyRefusal,
        });
        expect(output.releaseDecision?.refusal?.inputKeys).toEqual(["account"]);
        expect((output.rawValue as { totalSpending: number }).totalSpending)
          .toBe(145);
      } finally {
        await dispose();
      }
    });

    it("keeps the withheld decision on a run that fails to settle after the fit", async () => {
      // The fit runs before the result is read for its value, so a run that
      // exits at a settle failure is a run the boundary already decided at.
      // The decision is attached to that exit too: dropping it there would
      // lose the trace's record of exactly the refusals a failing run
      // provoked.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-decision-settle-failure",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { computed, pattern, Reactive } from 'commonfabric';",
              "interface Source { secret: string; }",
              "interface Input { amount: number; source: Reactive<Source>; }",
              "interface Output { total: number; boom: number; }",
              "export default pattern<Input, Output>(({ amount, source }) => ({",
              "  total: computed(() => amount + (source.secret ?? '').length),",
              "  boom: computed(() => { throw new Error('boom in lift'); }),",
              "}));",
              "",
            ].join("\n"),
            inputs: { amount: 2, source: sourceRef },
            resultSchema: {
              type: "object",
              properties: {
                total: { type: "number" },
                boom: { type: "number" },
              },
              required: ["total", "boom"],
            },
          },
        );
        const output = result.output as RunPatternToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain("failed while settling");
        expect(output.releaseDecision?.reasonCode).toBe("cfc_release_withheld");
        expect(output.releaseDecision?.refusal?.offendingAtoms).toEqual([
          '"secret"',
        ]);
        expect(output.releaseDecision?.refusal?.inputKeys).toEqual(["source"]);
      } finally {
        await dispose();
      }
    });

    it("names the input whose link reaches the labeled document through a link it holds", async () => {
      // The caller's address names the holder document; the label lives on
      // the document the holder's `account` field links to, which the
      // caller's address never names. The refused read is of that second
      // document, and what ties it back to `account` is the dereference the
      // attribution read performed to get there. The refusal names `account`
      // as the whole remedy rather than counting the document as one no
      // input accounts for.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const accountRef = await seedLabelledAccount(
          runtime,
          space,
          "release-field-addressed-input",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: SPENDING_PATTERN_SOURCE,
            inputs: { account: accountRef },
            resultSchema: TOTAL_SPENDING_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal).toEqual({
          gates: ["sink-ceiling"],
          sinks: ["run_pattern"],
          offendingAtoms: ['"finance"'],
          inputKeys: ["account"],
          attribution: "complete",
        });
        expect(output.valueError).toContain('input "account"');
        expect(output.valueError).toContain("without it releases its values");
      } finally {
        await dispose();
      }
    });

    it("names the input when the link it follows sits above the input's address", async () => {
      // The holder's root is itself a link, and the caller's address names
      // the `account` field beneath it: the dereference the attribution read
      // records starts above the address, so the address continues on the
      // far side of the link, into the account document's own `account`
      // field, where the label sits.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const refs = await seedAccountHolder(
          runtime,
          space,
          "release-root-linked-holder",
          "root-link",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: SPENDING_PATTERN_SOURCE,
            inputs: { account: refs.account },
            resultSchema: TOTAL_SPENDING_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal?.inputKeys).toEqual(["account"]);
        expect(output.policyRefusal?.attribution).toBe("complete");
      } finally {
        await dispose();
      }
    });

    it("does not name an input for a dereference the holder made somewhere else", async () => {
      // The holder links to the labeled account under `account` and to an
      // unlabeled document under `notes`, and both are inputs. The `notes`
      // dereference is recorded against the same holder document, but it
      // starts beside the `account` address rather than at, below, or above
      // it, so it leads the `account` input nowhere — and `notes` is not
      // named, since nothing it reaches carries the label.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const refs = await seedAccountHolder(
          runtime,
          space,
          "release-two-field-holder",
          "two-fields",
        );
        const result = await createStrictEngine(pieces).invokeBuiltinTool(
          "run_pattern",
          {
            sourceText: [
              "import { computed, pattern } from 'commonfabric';",
              "interface Transaction { amount: number; }",
              "interface Account { balance: number; transactions: Transaction[]; }",
              "interface Notes { text: string; }",
              "interface Input { account: Account; notes: Notes; }",
              "interface Output { totalSpending: number; noteLength: number; }",
              "export default pattern<Input, Output>(({ account, notes }) => ({",
              "  totalSpending: computed(() => account.transactions.reduce(",
              "    (sum, t) => sum + (t.amount < 0 ? -t.amount : 0),",
              "    0,",
              "  )),",
              "  noteLength: computed(() => notes.text.length),",
              "}));",
              "",
            ].join("\n"),
            inputs: { account: refs.account, notes: refs.notes },
            resultSchema: TOTAL_SPENDING_RESULT_SCHEMA,
          },
        );
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.policyRefusal?.inputKeys).toEqual(["account"]);
        expect(output.policyRefusal?.attribution).toBe("complete");
        expect(output.valueError).not.toContain('"notes"');
      } finally {
        await dispose();
      }
    });

    it("commits no unlabelled copy when a pattern-body map reads labelled values inline", async () => {
      // A pattern-body `.map()` runs as the built-in map, whose coordinator
      // reads the list raw. With the labelled values inline in that list, the
      // read carries their confidentiality into the stores the map writes —
      // its result container and one result document per element. Those are
      // stores the runtime owns, so each declares that confidentiality
      // (§8.12.5 route 2) rather than refusing the write, and the run
      // commits. Nothing copies the text even so: each element result is a
      // link into the labelled source path, so the labelled text exists at
      // rest only in the seeded source document.
      //
      // What the labels stop is the ANSWER. The model's context is outside
      // every space, so the answer ceiling withholds the value the tool would
      // return, and the handle it returns instead names a result that stays
      // in the space.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const seed = runtime.edit();
        const sourceCell = runtime.getCell(
          space,
          "body-map-inline-labelled",
          {
            type: "object",
            properties: { expenses: { type: "array", items: EXPENSE_SCHEMA } },
          },
          seed,
        );
        const sourceId = sourceCell.getAsNormalizedFullLink().id;
        writeSeedEnvelopeDoc(seed, space);
        seedStoredEnvelope(seed, {
          space,
          scope: "space",
          id: sourceId,
          path: [],
        }, {
          value: {
            expenses: [
              { description: "alpha-secret", amount: 1 },
              { description: "beta-secret", amount: 2 },
            ],
          },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [
                {
                  path: ["expenses", "0", "description"],
                  label: { confidentiality: ["expense-note"] },
                },
                {
                  path: ["expenses", "1", "description"],
                  label: { confidentiality: ["expense-note"] },
                },
              ],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const engine = createStrictEngine(pieces);
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: [
            "import { pattern, Reactive } from 'commonfabric';",
            "interface Expense { description: string; amount: number; }",
            "interface Source { expenses: Expense[]; }",
            "interface Input { source: Reactive<Source>; }",
            "interface Output { notes: string[]; }",
            "export default pattern<Input, Output>(({ source }) => ({",
            "  notes: source.expenses.map((e) => e.description),",
            "}));",
            "",
          ].join("\n"),
          inputs: {
            source: createLLMFriendlyLink(
              sourceCell.getAsNormalizedFullLink(),
              space,
            ),
          },
        });
        const output = result.output as RunPatternToolSuccessOutput;
        // The run commits and returns its handle; the answer ceiling gates the
        // VALUE, which stays in the space. The sibling below reaches the same
        // outcome from the linked shape, so inline values and linked ones now
        // differ only in which document holds the text.
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.policyRefusal).toBeUndefined();
        await runtime.idle();
        await pieces.synced();

        const piece = await pieces.get(output.pieceId);
        expect(await piece.result.get(["notes"])).toEqual([
          "alpha-secret",
          "beta-secret",
        ]);
        expect(
          docsHolding(runtime, space, `of:${output.pieceId}`, "alpha-secret"),
        ).toEqual([sourceId]);
      } finally {
        await dispose();
      }
    });

    it("resolves a pattern-body map over labelled documents to links, leaving the labelled text only in its sources", async () => {
      // With each labelled value in its own document behind a link, the
      // built-in map's coordinator reads only links, and each element result
      // is itself a link into the labelled source path. The result reads
      // back as the values, but no document at rest holds a copy at all: a
      // reader reaching the text does so through the source's own label map.
      // The call asks for no values, so what leaves the fabric for the model
      // is the reference alone, and nothing is measured or withheld.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const expenseIds: string[] = [];
        const elementLinks: {
          "/": {
            "link@1": {
              id: string;
              path: string[];
              scope: string;
              space: string;
            };
          };
        }[] = [];
        for (
          const [i, description] of ["alpha-secret", "beta-secret"].entries()
        ) {
          const seed = runtime.edit();
          const cell = runtime.getCell(
            space,
            `body-map-linked-expense-${i}`,
            EXPENSE_SCHEMA,
            seed,
          );
          const id = cell.getAsNormalizedFullLink().id;
          writeSeedEnvelopeDoc(seed, space);
          seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
            value: { description, amount: i + 1 },
            cfc: {
              version: 1,
              schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
              labelMap: {
                version: 1,
                entries: [{
                  path: ["description"],
                  label: { confidentiality: ["expense-note"] },
                }],
              },
            },
          });
          expect((await seed.commit()).ok).toBeDefined();
          expenseIds.push(id);
          elementLinks.push({
            "/": { "link@1": { id, path: [], scope: "space", space } },
          });
        }
        const listSeed = runtime.edit();
        const listCell = runtime.getCell(
          space,
          "body-map-linked-expense-list",
          { type: "array", items: EXPENSE_SCHEMA },
          listSeed,
        );
        listSeed.writeOrThrow(
          {
            space,
            scope: "space",
            id: listCell.getAsNormalizedFullLink().id,
            path: [],
          },
          { value: elementLinks },
        );
        expect((await listSeed.commit()).ok).toBeDefined();

        const engine = createStrictEngine(pieces);
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: [
            "import { pattern } from 'commonfabric';",
            "interface Expense { description: string; amount: number; }",
            "interface Input { expenses: Expense[]; }",
            "interface Output { notes: string[]; }",
            "export default pattern<Input, Output>(({ expenses }) => ({",
            "  notes: expenses.map((e) => e.description),",
            "}));",
            "",
          ].join("\n"),
          inputs: {
            expenses: createLLMFriendlyLink(
              listCell.getAsNormalizedFullLink(),
              space,
            ),
          },
        });
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.value).toBeUndefined();
        expect(output.policyRefusal).toBeUndefined();
        await runtime.idle();
        await pieces.synced();

        const piece = await pieces.get(output.pieceId);
        expect(await piece.result.get(["notes"])).toEqual([
          "alpha-secret",
          "beta-secret",
        ]);
        expect(
          docsHolding(runtime, space, `of:${output.pieceId}`, "alpha-secret"),
        ).toEqual([expenseIds[0]]);
        expect(
          docsHolding(runtime, space, `of:${output.pieceId}`, "beta-secret"),
        ).toEqual([expenseIds[1]]);
      } finally {
        await dispose();
      }
    });

    it("returns a `compile-error` output carrying the raw diagnostics without failing the run", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "this is not a pattern ((",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("compile-error");
      expect(output.message.length).toBeGreaterThan(0);
      expect(result.runState.status).not.toBe("failed");
    });

    it("returns an error when `sourceText` is missing", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {});
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires sourceText");
    });

    it("returns an error for a `sourceText` over the size cap without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "x".repeat(RUN_PATTERN_MAX_SOURCE_TEXT_BYTES + 1),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("256 KiB limit");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a link input targeting another space without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const foreignRef = `/@did:key:z6MkforeignSpaceForRunPatternTest/of:fid1:${
        "A".repeat(43)
      }/`;
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: foreignRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("targets another space");
      expect(spy.calls).toBe(0);
    });

    it("runs over an admitted foreign input while retaining its CFC labels", async () => {
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const foreign = (await createSession({
          identity: signer,
          spaceName: `foreign-input-${crypto.randomUUID()}`,
        })).space;
        const tx = runtime.edit();
        const source = runtime.getCell(
          foreign,
          "foreign-labeled-input",
          undefined,
          tx,
        );
        const link = source.getAsNormalizedFullLink();
        const label = {
          confidentiality: ["secret"],
          integrity: ["topic-source"],
        };
        writeSeedEnvelopeDoc(tx, foreign);
        seedStoredEnvelope(tx, { ...link, path: [] }, {
          value: { secret: "s3cr3t" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
          },
        });
        expect((await tx.commit()).ok).toBeDefined();
        const ref = createLLMFriendlyLink(link, space);
        const engine = new CfHarnessEngine({
          sandboxRuntime: new FakeSandboxRuntime(),
          runId: `foreign-labels-${crypto.randomUUID()}`,
          inputCells: [{ name: "source", ref }],
          fabricSessionFactory: () =>
            Promise.resolve({
              pieces,
              foreignSpaces: { [foreign]: "https://foreign.example/" },
            }),
        });
        const [attached] = await engine.establishInputCells();
        const admittedRef =
          resolveHandleToken(engine.handleTable!, attached.token)!.ref;
        expect(admittedRef).toContain(foreign);
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: [
            "import { pattern } from 'commonfabric';",
            "interface Input { source: { secret: string }; }",
            "interface Output { secret: string; }",
            "export default pattern<Input, Output>(({ source }) => ({",
            "  secret: source.secret,",
            "}));",
          ].join("\n"),
          inputs: { source: admittedRef },
          resultSchema: {
            type: "object",
            properties: { secret: { type: "string" } },
            required: ["secret"],
          },
        });
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect(output.rawValue).toEqual({ secret: "s3cr3t" });
        expect(output.value).toBeUndefined();
        expect(output.valueError).toContain("policy refused to release");
        const forwarded = runtime.getCellFromLink(
          parseLLMFriendlyLink(output.resultRef, space),
        ).key("secret");
        expect(forwarded.get()).toBe("s3cr3t");
        expect(cfcLabelViewForCellFailClosed(forwarded)?.entries)
          .toContainEqual({
            path: [],
            label,
            observes: "followRef",
          });
        const foreignSecret = runtime.getCellFromLink(link).key("secret");
        expect(foreignSecret.get()).toBe("s3cr3t");
        expect(cfcLabelViewForCellFailClosed(foreignSecret)?.entries)
          .toContainEqual({
            path: [],
            label,
          });
      } finally {
        await dispose();
      }
    });

    it("returns an error for a live-cell input whose value does not match the argument schema, creating no piece", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-shape-mismatch",
        {
          type: "object",
          properties: { foo: { type: "number" } },
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set({ foo: 1 });
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming an input the pattern's argument schema does not declare, creating no piece", async () => {
      // A misnamed input is the mismatch a shape check cannot see: the
      // pattern runs with its argument undefined, computes nothing from it,
      // and renders a complete page holding no values. Refusing before the
      // piece exists turns that into something the model can correct.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { count: 21 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('"count"');
      expect(output.message).toContain('it declares "n"');
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming an input that is a sealed opaque link, creating no piece", async () => {
      // A seal is a redaction, so storing it would leave a dead literal where
      // the pattern declared a live reference: the piece would run, compute
      // nothing from that argument, and report `ok`.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: SEALED_OPAQUE_LINK },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("sealed opaque link");
      expect(output.message).toContain("redaction, not an address");
      expect(output.message).toContain("cfh:a:");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the path of a sealed opaque link nested inside an object input, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: SEALED_OPAQUE_LINK } },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "overview"');
      expect(output.message).toContain('at "overview.title"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the path of a bare seal target string nested inside an object input, creating no piece", async () => {
      // The seal is the `opaque:` target, not the object it arrived in. Lifted
      // out of that object it reaches any position the argument schema admits
      // a string — here `overview.title`, which the pattern declares as one —
      // and it is the same redaction there.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: SEALED_OPAQUE_TARGET } },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "overview"');
      expect(output.message).toContain('at "overview.title"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for an `@link` object carrying a seal target alongside another key, creating no piece", async () => {
      // A model that copied the seal out along with a sibling key it wrote
      // itself still passed back the redaction; the wrapper's shape is not
      // what makes it one.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: {
          overview: { "@link": SEALED_OPAQUE_TARGET, note: "the overview" },
        },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      // The object itself is the seal, so the refusal names the input rather
      // than a path to the `@link` key inside it.
      expect(output.message).toContain(
        'input "overview" is a sealed opaque link',
      );
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("runs an input the argument schema admits through an `additionalProperties` schema rather than by name", async () => {
      // An `additionalProperties` schema is an index signature: it permits the
      // undeclared key and says what it may hold. Refusing such a key would
      // reject an input the pattern's own schema accepts.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: 5 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
    });

    it("returns an error for an undeclared input whose value the `additionalProperties` schema rejects, creating no piece", async () => {
      // The test above is this one's control: the same pattern accepts the
      // same undeclared key when its value is what `additionalProperties`
      // describes. Admitting an undeclared key is a statement about what it
      // may hold, so the value is still measured — against that schema rather
      // than against a declared property's.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: "five" },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "offset"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for an undeclared live-cell input whose value the `additionalProperties` schema rejects, creating no piece", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-open-seed",
        {
          type: "string",
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set("five");
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OPEN_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: seedRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "offset"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the position of a sealed opaque link inside an array input, creating no piece", async () => {
      // A model composes an input out of what an earlier result handed it, and
      // an array is one of the shapes it composes. The seal is the same
      // redaction at index 1 of a list as it is at the top of an input.
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ROW_COUNT_PATTERN_SOURCE,
        inputs: { rows: ["first", SEALED_OPAQUE_TARGET] },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "rows"');
      expect(output.message).toContain('at "rows[1]"');
      expect(output.message).toContain("redaction, not an address");
      expect(spy.calls).toBe(0);
    });

    it("runs an array input whose entries carry no sealed opaque link", async () => {
      // The control for the case above: the same pattern and the same shape of
      // input, so the refusal there is the seal rather than the array.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ROW_COUNT_PATTERN_SOURCE,
        inputs: { rows: ["first", "second"] },
        resultSchema: ROW_COUNT_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ rowCount: 2 });
    });

    it("keeps a link-shaped string that does not parse as a link as the input's plain value", async () => {
      // A string can wear the shape of an LLM-friendly link without being one:
      // this one carries a piece handle too short to be a fabric identifier. It
      // is the input's value, not a reference, so the pattern computes over the
      // string itself.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: LABEL_PATTERN_SOURCE,
        inputs: { label: "/of:fid1:short/x" },
        resultSchema: LABEL_LENGTH_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ labelLength: "/of:fid1:short/x".length });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["label"])).toBe("/of:fid1:short/x");
    });

    it("runs an undeclared input the argument schema admits without saying what it may hold", async () => {
      // `additionalProperties: true` states that an undeclared key is
      // permitted and nothing about its value, so there is no schema to
      // measure it against and no shape it can fail.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ANY_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: "five" },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["offset"])).toBe("five");
    });

    it("runs an undeclared live-cell input the argument schema admits without saying what it may hold", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-any-seed",
        {
          type: "string",
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set("five");
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ANY_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21, offset: seedRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42 });
      const piece = await pieces.get(output.pieceId);
      expect(await piece.input.get(["offset"])).toBe("five");
    });

    it("returns an error for a plain-JSON input whose value does not match the argument schema, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: "twenty-one" },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("runs a plain-JSON object input that matches its declared argument schema", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: OVERVIEW_PATTERN_SOURCE,
        inputs: { overview: { title: "Weekly" } },
        resultSchema: TITLE_LENGTH_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ titleLength: 6 });
    });

    it("returns a `cancelled` output when the signal aborts while the settle race is underway", async () => {
      // The abort lands after the race over the settle barrier has been
      // entered — a microtask later, not before — so the live race path
      // itself answers, rather than the pre-aborted short-circuit.
      const controller = new AbortController();
      const runtimeWithSettled = runtime as unknown as {
        settled: () => Promise<void>;
      };
      runtimeWithSettled.settled = () => {
        queueMicrotask(() => controller.abort());
        return new Promise<void>(() => {});
      };
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
    });

    it("serializes a plain value and answers undefined for one JSON cannot carry", () => {
      expect(asSerializableValue({ n: 1 })).toEqual({ n: 1 });
      expect(asSerializableValue(7n)).toBeUndefined();
    });

    it("returns a `cancelled` output and stops the piece when the signal aborts during the settle barrier", async () => {
      const controller = new AbortController();
      // Abort exactly when the tool reaches its post-create barrier, and
      // hold the barrier open so only the signal can win the race.
      const runtimeWithSettled = runtime as unknown as {
        settled: () => Promise<void>;
      };
      runtimeWithSettled.settled = () => {
        controller.abort();
        return new Promise<void>(() => {});
      };
      const stopped: unknown[] = [];
      const runner = runtime.runner as unknown as {
        stop: (cell: unknown) => unknown;
      };
      const originalStop = runner.stop.bind(runtime.runner);
      runner.stop = (cell) => {
        stopped.push(cell);
        return originalStop(cell);
      };
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("cancelled");
      expect(stopped.length).toBe(1);
      expect(result.runState.status).not.toBe("failed");
    });

    it("returns a `cancelled` output when the signal aborts during the release measurement", async () => {
      // The measurement opens its transactions before it awaits anything, so
      // aborting on that call lands the signal while the phase is in flight.
      const { runtime, pieces, space, dispose } = await createStrictFabric();
      try {
        const sourceRef = await seedLabelledSecret(
          runtime,
          space,
          "release-cancelled",
        );
        const controller = new AbortController();
        const pristineEdit = runtime.edit.bind(runtime);
        let measurementReached = false;
        const runtimeWithEdit = runtime as unknown as {
          edit: () => ReturnType<typeof pristineEdit>;
        };
        runtimeWithEdit.edit = () => {
          // Every earlier transaction belongs to setup; the release
          // measurement is what opens one after the piece has settled.
          if (measurementReached) controller.abort();
          return pristineEdit();
        };
        const stopped: unknown[] = [];
        const runner = runtime.runner as unknown as {
          stop: (cell: unknown) => unknown;
        };
        const originalStop = runner.stop.bind(runtime.runner);
        runner.stop = (cell) => {
          stopped.push(cell);
          return originalStop(cell);
        };
        const engine = createStrictEngine(pieces);
        const settledBefore = pieces.synced.bind(pieces);
        (pieces as unknown as { synced: () => Promise<void> }).synced =
          async () => {
            await settledBefore();
            measurementReached = true;
          };

        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourceText: OPTIONAL_SECRET_PATTERN_SOURCE,
          inputs: { amount: 2, source: sourceRef },
          resultSchema: TOTAL_RESULT_SCHEMA,
        }, { signal: controller.signal });

        const output = result.output as RunPatternToolErrorOutput;
        expect(output.status).toBe("cancelled");
        expect(stopped.length).toBe(1);
      } finally {
        await dispose();
      }
    });

    it("returns a `cancelled` output when the signal aborts during the output-concern scan", async () => {
      // The scan is the one reader of `since()`, and it asks as it begins, so
      // aborting there lands the signal while the scan is in flight — with
      // the release measurement's own race already resolved.
      const controller = new AbortController();
      const aborting: FabricPatternInstantiations = {
        sequence: () => recorder.instantiations.sequence(),
        since: (from) => {
          controller.abort();
          return recorder.instantiations.since(from);
        },
        keylessSince: (from) => recorder.instantiations.keylessSince(from),
      };
      const stopped: unknown[] = [];
      const runner = runtime.runner as unknown as {
        stop: (cell: unknown) => unknown;
      };
      const originalStop = runner.stop.bind(runtime.runner);
      runner.stop = (cell) => {
        stopped.push(cell);
        return originalStop(cell);
      };

      const result = await createEngine(aborting).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: DOUBLING_PATTERN_SOURCE,
          inputs: { n: 21 },
          resultSchema: DOUBLED_RESULT_SCHEMA,
        },
        { signal: controller.signal },
      );
      const output = result.output as RunPatternToolErrorOutput;

      expect(output.status).toBe("cancelled");
      expect(stopped.length).toBe(1);
    });

    it("surfaces a rejected session construction as a structured error and invokes the factory again on the next call", async () => {
      let factoryCalls = 0;
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () => {
          factoryCalls += 1;
          return Promise.reject(
            new Error("authorization denied for the configured space"),
          );
        },
      });
      const first = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      const firstOutput = first.output as RunPatternToolErrorOutput;
      expect(firstOutput.status).toBe("error");
      expect(firstOutput.message).toContain("fabric session unavailable");
      expect(firstOutput.message).toContain("authorization denied");
      const second = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      expect((second.output as RunPatternToolErrorOutput).status).toBe(
        "error",
      );
      expect(factoryCalls).toBe(2);
    });

    it("leaves the created piece out of the space's real registered piece list", async () => {
      // A real default pattern first: without one, `getRegisteredPieces()`
      // reads a detached always-empty fallback and the assertion below
      // holds vacuously.
      const defaultRoot = await pieces.create(DEFAULT_PATTERN_SOURCE, {
        input: { pieceRegistry: [] },
      });
      await pieces.linkDefaultPattern(defaultRoot.getCell());
      await runtime.idle();
      await pieces.synced();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.length).toBe(0);
      // The registry observes registration, proving the zero above is a
      // decision by the tool and not an inert list.
      const control = await pieces.create(DOUBLING_PATTERN_SOURCE, {
        input: { n: 2 },
      });
      await pieces.add([control.getCell()]);
      const afterAdd = await pieces.getRegisteredPieces();
      expect(afterAdd.length).toBe(1);
    });

    it("returns a `cancelled` output without creating a piece when the signal is already aborted", async () => {
      const spy = spyOnRunPersistent();
      const controller = new AbortController();
      controller.abort();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("cancelled");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a `resultSchema` that is not a JSON Schema, creating no piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
        resultSchema: "{ not json",
      } as unknown as RunPatternToolInput);
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "resultSchema string must be valid JSON",
      );
      expect(spy.calls).toBe(0);
    });

    it("returns an error naming the configuration a run without a fabric session is missing", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
      });
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a fabric session");
      expect(output.message).toContain("--fabric-space");
    });
  });

  describe("live-cell input validation from a cold session", () => {
    // Two replicas on one loopback server: the writer seeds and pushes, the
    // reader session starts cold, never having pulled what the input's
    // referent links to. A single emulated manager cannot exercise this —
    // seeding through it warms the very cache the validation read depends
    // on. This is the shape of the piece-registry grant: the granted address
    // resolves through a link, so a schema-less validation read in a fresh
    // session measures `undefined` where the value is.
    let server: ReturnType<typeof newLoopbackServer>;
    let spaceName: string;
    let writerStorage: EmulatedStorageManager;
    let writerRuntime: Runtime;
    let writerPieces: PiecesController;
    let readerStorage: EmulatedStorageManager | undefined;
    let readerRuntime: Runtime | undefined;

    beforeEach(async () => {
      server = newLoopbackServer();
      spaceName = `run-pattern-cold-${crypto.randomUUID()}`;
      writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      writerRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: writerStorage,
      });
      writerPieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        writerRuntime,
      );
      await writerPieces.synced();
      readerStorage = undefined;
      readerRuntime = undefined;
    });

    // Connected after the writer has seeded and pushed, so the reader's
    // first sight of every seeded doc is a cold pull from the server.
    const connectReader = async (): Promise<PiecesController> => {
      readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      readerRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: readerStorage,
      });
      const readerPieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        readerRuntime,
      );
      await readerPieces.synced();
      return readerPieces;
    };

    afterEach(async () => {
      await readerRuntime?.dispose();
      await readerStorage?.close();
      await writerRuntime?.dispose();
      await writerStorage?.close();
      await server?.close();
    });

    it("validates a live-cell input whose referent sits behind a link the session has not pulled, and runs the pattern", async () => {
      const space = writerPieces.getSpace();
      const target = writerRuntime.getCell<number>(
        space,
        "run-pattern-cold-target",
        { type: "number" },
      );
      const wrapper = writerRuntime.getCell(space, "run-pattern-cold-wrapper");
      const seeded = await writerRuntime.editWithRetry((tx) => {
        target.withTx(tx).set(7);
        wrapper.withTx(tx).set(target.getAsLink());
      });
      expect(seeded.error).toBeUndefined();
      await writerRuntime.idle();
      await writerPieces.synced();
      const wrapperRef = createLLMFriendlyLink(
        wrapper.getAsNormalizedFullLink(),
        space,
      );

      const readerPieces = await connectReader();
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () => Promise.resolve({ pieces: readerPieces }),
      });
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: wrapperRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(14);
    });

    it("validates the piece-registry grant address as a live-cell input and runs the pattern", async () => {
      // The writer gives the space a default pattern whose stored document
      // reads as `undefined` through the whole-document untyped view — a
      // shape `getDefaultPattern` itself tolerates (see
      // `packages/piece/test/ensure-default-pattern.test.ts`) — anchoring
      // the piece-registry well-known grant the way a real space does. The
      // emulated client materializes more eagerly than a remote session, so
      // this pins the grant-address wiring rather than discriminating the
      // schema-carrying validation read; that discrimination needs a live
      // toolshed.
      const mockDefaultPattern = writerRuntime.getCell(
        writerPieces.getSpace(),
        "run-pattern-mock-default-pattern",
        {
          type: "object",
          properties: {
            pieceRegistry: { type: "array" },
            missing: { type: "string" },
          },
          required: ["missing"],
        } as const,
      );
      await writerRuntime.editWithRetry((tx) => {
        mockDefaultPattern.withTx(tx).setRawUntyped({ pieceRegistry: [] });
      });
      await writerPieces.linkDefaultPattern(mockDefaultPattern);
      await writerRuntime.idle();
      await writerPieces.synced();

      // The reader resolves the grant the way the harness does at run
      // start: an address-only walk that pulls nothing the registry lists.
      const readerPieces = await connectReader();
      const [grant] = await resolveWellKnownGrantRefs(
        { pieces: readerPieces } as HarnessFabricSession,
      );
      expect(grant?.name).toBe("piece-registry");

      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        fabricSessionFactory: () => Promise.resolve({ pieces: readerPieces }),
      });
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: ENTRY_COUNT_PATTERN_SOURCE,
        inputs: { entries: grant!.ref },
        resultSchema: ENTRY_COUNT_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { count: number }).count).toBe(0);
    });
  });

  describe("runPatternPolicyRefusal()", () => {
    it("returns `undefined` for an empty refusal list", () => {
      expect(runPatternPolicyRefusal([], () => [])).toBeUndefined();
    });

    it("names the sink whose ceiling refused for a `sink-ceiling` detail", () => {
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            gate: "sink-ceiling",
            sink: "fetchText",
            inputs: [refusalInput("source-doc")],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["sink-ceiling"],
        sinks: ["fetchText"],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        attribution: "complete",
      });
    });

    it("deduplicates the gates, sinks, offending atoms and input keys of several details", () => {
      expect(
        runPatternPolicyRefusal(
          [
            refusalDetail({
              gate: "sink-ceiling",
              sink: "fetchText",
              offendingAtoms: ['"secret"', '"medical"'],
              inputs: [refusalInput("source-doc")],
            }),
            refusalDetail({
              gate: "sink-ceiling",
              sink: "fetchText",
              offendingAtoms: ['"medical"'],
              inputs: [refusalInput("source-doc", ["notes"])],
            }),
            refusalDetail({
              gate: "writer-fit",
              inputs: [refusalInput("other-doc")],
            }),
          ],
          inputKeysByDocument({
            "source-doc": "source",
            "other-doc": "notes",
          }),
        ),
      ).toEqual({
        gates: ["sink-ceiling", "writer-fit"],
        sinks: ["fetchText"],
        offendingAtoms: ['"secret"', '"medical"'],
        inputKeys: ["source", "notes"],
        attribution: "complete",
      });
    });

    it("counts a structured offending atom into `withheldAtomCount` rather than naming it", () => {
      // A `Caveat` atom carries the principal that introduced it, and nothing
      // redacts a principal out of an atom already rendered to a string.
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            offendingAtoms: [
              '"secret"',
              '{"caveat":"only-for","source":"did:key:zIntroducer"}',
            ],
            inputs: [refusalInput("source-doc")],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        withheldAtomCount: 1,
        inputKeys: ["source"],
        attribution: "complete",
      });
    });

    it("counts an offending atom whose rendering is not JSON into `withheldAtomCount`", () => {
      // `renderCfcAtom` is `JSON.stringify`, which produces no JSON text at
      // all for an atom it cannot carry, so the rendering reaching this fold
      // need not parse.
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            offendingAtoms: ['"secret"', "undefined"],
            inputs: [refusalInput("source-doc")],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        withheldAtomCount: 1,
        inputKeys: ["source"],
        attribution: "complete",
      });
    });

    it("names every input key one refused document was supplied under", () => {
      // One document handed in under two keys is reached by dropping either
      // alias alone, so a remedy naming one of them leaves the other
      // carrying the label.
      expect(
        runPatternPolicyRefusal([
          refusalDetail({ inputs: [refusalInput("source-doc")] }),
        ], inputKeysByDocument({ "source-doc": ["source", "alsoSource"] })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source", "alsoSource"],
        attribution: "complete",
      });
    });

    it("returns `partial` with the unowned read counted when one offending read belongs to no input key", () => {
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            inputs: [refusalInput("source-doc"), refusalInput("hidden-doc")],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        unattributedInputCount: 1,
        attribution: "partial",
      });
    });

    it("counts two paths of one unowned document as a single unattributed input", () => {
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            inputs: [
              refusalInput("hidden-doc", ["notes"]),
              refusalInput("hidden-doc", ["archive", "notes"]),
              refusalInput("source-doc"),
            ],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        unattributedInputCount: 1,
        attribution: "partial",
      });
    });

    it("returns `none` when no offending read belongs to an input of the call", () => {
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            inputs: [
              refusalInput("hidden-doc"),
              refusalInput("other-hidden-doc"),
            ],
          }),
        ], () => []),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: [],
        unattributedInputCount: 2,
        attribution: "none",
      });
    });

    it("returns `partial` for a detail the boundary itself attributed partially, though every named read is an input key", () => {
      expect(
        runPatternPolicyRefusal([
          refusalDetail({
            attribution: "partial",
            inputs: [refusalInput("source-doc")],
          }),
        ], inputKeysByDocument({ "source-doc": "source" })),
      ).toEqual({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        attribution: "partial",
      });
    });
  });

  describe("policyRefusalMessage()", () => {
    it("names the single sink whose ceiling refused and the one input to drop", () => {
      const message = policyRefusalMessage({
        gates: ["sink-ceiling"],
        sinks: ["fetchText"],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        attribution: "complete",
      }, "commit");
      expect(message).toContain(
        'the sink "fetchText" does not admit the confidentiality ("secret")',
      );
      expect(message).toContain(
        'Every label refused here came in through input "source", so the same run without it proceeds',
      );
    });

    it("says the values are withheld and the reference stands when the release boundary refused", () => {
      // The answer's own sink refuses what the run already landed, so what
      // the caller is told became of the result differs from a refused
      // commit: it exists, in the space, under its own labels, and the
      // caller holds its reference with the values withheld — so the remedy
      // releases values rather than making the run proceed.
      const message = policyRefusalMessage({
        gates: ["sink-ceiling"],
        sinks: ["run_pattern"],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        attribution: "complete",
      }, "release");
      expect(message).toContain("policy refused to release its values");
      expect(message).toContain("resultRef still names the result");
      expect(message).toContain("without it releases its values");
      expect(message).not.toContain("never landed");
    });

    it("names both sinks when two ceilings refused", () => {
      expect(policyRefusalMessage({
        gates: ["sink-ceiling"],
        sinks: ["fetchText", "postMessage"],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        attribution: "complete",
      }, "commit")).toContain(
        'the sinks "fetchText", "postMessage" does not admit',
      );
    });

    it("names the write it attempted and both inputs to drop when no sink refused", () => {
      const message = policyRefusalMessage({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"', '"medical"'],
        inputKeys: ["source", "notes"],
        attribution: "complete",
      }, "commit");
      expect(message).toContain(
        'the write it attempted does not admit the confidentiality ("secret", "medical")',
      );
      expect(message).toContain(
        'Every label refused here came in through inputs "source", "notes", so the same run without them proceeds',
      );
    });

    it("omits the confidentiality parenthetical when every offending atom was withheld", () => {
      const message = policyRefusalMessage({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: [],
        withheldAtomCount: 2,
        inputKeys: ["source"],
        attribution: "complete",
      }, "commit");
      expect(message).toContain(
        "the write it attempted does not admit the confidentiality this run carries",
      );
    });

    it("states that dropping the named inputs only narrows the flow for a `partial` attribution", () => {
      expect(policyRefusalMessage({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source", "notes"],
        unattributedInputCount: 1,
        attribution: "partial",
      }, "commit")).toContain(
        'Some of what was refused came in through inputs "source", "notes"; dropping them narrows the flow without necessarily clearing it, since reads this call does not own carry refused labels too',
      );
    });

    it("states that dropping the single named input only narrows the flow for a `partial` attribution", () => {
      expect(policyRefusalMessage({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: ["source"],
        unattributedInputCount: 1,
        attribution: "partial",
      }, "commit")).toContain(
        'came in through input "source"; dropping it narrows the flow',
      );
    });

    it("states that no input of the call accounts for the refusal for a `none` attribution", () => {
      expect(policyRefusalMessage({
        gates: ["writer-fit"],
        sinks: [],
        offendingAtoms: ['"secret"'],
        inputKeys: [],
        unattributedInputCount: 1,
        attribution: "none",
      }, "commit")).toContain(
        "No input of this call accounts for what was refused, so dropping an input will not clear it",
      );
    });
  });
});
