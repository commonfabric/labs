import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { Database } from "@db/sqlite";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { DEFAULT_SCAN_LIMIT } from "@commonfabric/state-inspector";
import { PiecesController } from "@commonfabric/piece/ops";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager as WorkerStorageManager } from "@commonfabric/runner/storage/cache";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { resetProcessDeployment } from "../lib/process-deployment.ts";
import {
  type CompletionLine,
  declaredSlots,
  longName,
  resolveCompletionLine,
} from "../lib/completion/line.ts";
import type { Directive } from "../lib/completion/providers.ts";
import {
  acceptedProjections,
  completionProviderKeys,
  descendProjection,
  entityListingView,
  liveCandidates,
  pieceWithPathPrefix,
  projectionKeys,
  resolvePieceContext,
  resolveSpaceContext,
  shapeEntityCandidates,
  shapePieceCandidates,
  shapeProjectionCandidates,
  shapeSlugCandidates,
  shapeVerbCandidates,
  splitPathPrefix,
  splitPiecePathPrefix,
  splitSelectPrefix,
  wishTargetCandidates,
} from "../lib/completion/providers.ts";
import { listCellKeys } from "../lib/cell-listing.ts";
import {
  parseSelectionProjection,
  parseSelectProjection,
} from "../lib/cell-selection.ts";
import { tokenizeLine } from "../lib/completion/mod.ts";
import { main } from "../commands/main.ts";
import { wish } from "../commands/wish.ts";

function lineFor(text: string) {
  const { words, cword } = tokenizeLine(text, text.length);
  return resolveCompletionLine(main, words, cword);
}

/**
 * Run `body` with the fabric environment variables set exactly as given,
 * restoring whatever the surrounding process had. Completion reads these as
 * fallbacks, so a test that did not control them would pass or fail based on
 * the developer's shell.
 */
async function withEnv(
  env: { identity?: string; apiUrl?: string },
  body: () => void | Promise<void>,
): Promise<void> {
  const keys = ["CF_IDENTITY", "CF_API_URL"] as const;
  const saved = keys.map((key) => [key, Deno.env.get(key)] as const);
  try {
    Deno.env.delete("CF_IDENTITY");
    Deno.env.delete("CF_API_URL");
    if (env.identity) Deno.env.set("CF_IDENTITY", env.identity);
    if (env.apiUrl) Deno.env.set("CF_API_URL", env.apiUrl);
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** Capture stdout writes made by a command action. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => void chunks.push(args.join(" "));
  try {
    await body();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

Deno.test("space context: line options beat the environment", async () => {
  // This is what makes `-s other-space --piece <TAB>` list the other space
  // rather than whatever the shell's environment points at.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf piece ls -i /line.key -a http://line:8000 -s team "),
    );
    assert(config);
    assertEquals(config.apiUrl, "http://line:8000");
    assertEquals(config.space, "team");
    assertEquals(config.identity, "/line.key");
  });
});

Deno.test("space context: falls back to the environment", async () => {
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(lineFor("cf piece ls -s team "));
    assert(config);
    assertEquals(config.apiUrl, "http://env:9999");
    assertEquals(config.identity, "/env.key");
  });
});

Deno.test("space context: --url supplies api-url and space together", async () => {
  await withEnv({ identity: "/env.key" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf piece ls -u http://host:8000/myspace/fid1:abc "),
    );
    assert(config);
    assertEquals(config.apiUrl, "http://host:8000");
    assertEquals(config.space, "myspace");
  });
});

Deno.test("space context: reserves stdout for candidates", async () => {
  // `jsonOutput` routes runtime status lines to stderr. Without it a stray
  // console.log from the runtime would be offered to the user as a candidate.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -s t "))?.jsonOutput,
      true,
    );
  });
});

Deno.test("space context: an incomplete line resolves to nothing", async () => {
  await withEnv({}, () => {
    // No identity anywhere.
    assertEquals(resolveSpaceContext(lineFor("cf piece ls -s team ")), null);
  });
  await withEnv({ identity: "/env.key" }, () => {
    // Identity but no space.
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -a http://h:1 ")),
      null,
    );
    // Identity but no api-url.
    assertEquals(resolveSpaceContext(lineFor("cf piece ls -s team ")), null);
  });
});

Deno.test("space context: a malformed --url resolves to nothing, not a throw", async () => {
  await withEnv({ identity: "/env.key" }, () => {
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -u not-a-url ")),
      null,
    );
  });
});

Deno.test("space context: an embedded space supplies one the line did not name", async () => {
  // A canonical reference carries the space DID, which is the one spelling a
  // line can name a space with and never write `--space`.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf cell get --piece /@did:key:zEmbedded/of:fid1:abc "),
      "did:key:zEmbedded",
    );
    assert(config);
    assertEquals(config.space, "did:key:zEmbedded");
  });
});

Deno.test("space context: the line's own --space wins over an embedded one", async () => {
  // Which of the two is right is the command's judgment to make; completion
  // offers candidates and defers, so it reads the space the caller wrote.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    assertEquals(
      resolveSpaceContext(
        lineFor("cf cell get -s team --piece /@did:key:zEmbedded/of:fid1:abc "),
        "did:key:zEmbedded",
      )?.space,
      "team",
    );
  });
});

Deno.test("piece context: #argument reads the same on both spellings of a target", async () => {
  // Completion reads the target through the grammar the command's own intake
  // reads it with, so a suffix the command honors is a suffix the keys
  // offered behind it come from the arguments cell for.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const rooted = resolvePieceContext(
      lineFor("cf cell get -s demo --piece /thermostat#argument "),
    );
    const bare = resolvePieceContext(
      lineFor("cf cell get -s demo --piece thermostat#argument "),
    );
    assert(rooted);
    assert(bare);
    // The whole context, not just the suffix: "read the same" is the claim,
    // and a spelling that agreed on `pieceInput` while disagreeing on the
    // space or the piece would satisfy a narrower one.
    assertEquals(bare, rooted);
    assertEquals(bare.piece, "thermostat");
    assertEquals(bare.pieceInput, true);
    // A scope written after the member survives it.
    assertEquals(
      resolvePieceContext(
        lineFor("cf cell get -s demo --piece thermostat#argument@session "),
      )?.pieceScope,
      "session",
    );
    // Nothing but the suffix selects that cell, and a plain slug still
    // resolves — a context of `null` there is a slot offering nothing.
    const plain = resolvePieceContext(
      lineFor("cf cell get -s demo --piece thermostat "),
    );
    assert(plain);
    assertFalse(plain.pieceInput);
    // A fragment the grammar refuses is a half-typed word, not a throw.
    assertEquals(
      resolvePieceContext(
        lineFor("cf cell get -s demo --piece thermostat#res "),
      ),
      null,
    );
  });
});

Deno.test("live candidates: a listing that raises completes to nothing", async () => {
  // The two halves of one split. `listCellKeys` raises, because `cf`'s
  // callers have to tell a leaf from a read that never happened; the provider
  // dispatch turns that into an empty answer, because a stack trace pasted
  // between two keystrokes is the wrong answer at any prompt.
  //
  // The line carries its whole connection, so the identity that cannot be
  // read is the failure under test rather than whatever the surrounding
  // environment holds.

  const text = "cf cell get --identity /nonexistent/missing.key " +
    "--api-url http://127.0.0.1:1 --space test --piece fid1:abc items/";
  const line = lineFor(text);
  const config = resolveSpaceContext(line);
  assert(config, "the line names a connection");
  await assertRejects(() =>
    listCellKeys({ ...config, piece: "fid1:abc" }, "items")
  );

  const result = await liveCandidates(line);
  assertEquals(result.candidates, []);
  assertEquals(result.directives, []);
});

Deno.test("live candidates: unmapped slots ask for nothing", async () => {
  // A subcommand or option-name slot is answered statically; reaching for live
  // data there would spend a fabric round trip per keystroke for no reason.
  for (const text of ["cf ", "cf piece ls --", "cf piece "]) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.candidates.length, 0, text);
    assertEquals(result.directives.length, 0, text);
  }
});

/**
 * Every slot whose whole answer is a shell handoff, and the directive it must
 * hand over. The kind and the glob are the assertion: a wrong glob is the
 * "wrong set" defect in its quietest form, since the slot still answers, with
 * the wrong files, and nothing upstream can tell.
 *
 * Hand-written, because what each slot SHOULD hand over is not derivable from
 * the code that hands it over. Which slots belong here is derivable, and is
 * derived below rather than remembered.
 */
const DIRECTIVE_CASES: Array<[string, string, string | undefined]> = [
  ["cf piece ls -i ", "files", "*.key"],
  ["cf id did ", "files", "*.key"],
  // Every command whose `--root` is the directory its sources resolve
  // against. The set is hand-maintained, so it is asserted whole.
  ["cf piece new --root ", "dirs", undefined],
  ["cf piece setsrc --root ", "dirs", undefined],
  ["cf piece survey --root ", "dirs", undefined],
  ["cf space set-home --root ", "dirs", undefined],
  ["cf piece set-home --root ", "dirs", undefined],
  ["cf check --root ", "dirs", undefined],
  ["cf test --root ", "dirs", undefined],
  ["cf piece new --test ", "files", "*.tsx"],
  ["cf piece new ", "files", "*.tsx"],
  ["cf piece setsrc ", "files", "*.tsx"],
  ["cf check ", "files", "*.tsx"],
  ["cf test ", "files", "*.tsx"],
  ["cf piece new --datafile ", "files", undefined],
  ["cf view ", "files", undefined],
  ["cf exec ", "files", undefined],
  ["cf space clone --to ", "dirs", undefined],
  ["cf space clone x --from ", "files", undefined],
  ["cf space verify ", "dirs", undefined],
  ["cf space reset ", "dirs", undefined],
  ["cf inspect spaces --dir ", "dirs", undefined],
  ["cf inspect html x --out ", "files", undefined],
  ["cf check --output ", "files", undefined],
  ["cf agent runner --loom-retrieval-config ", "files", "*.json"],
  ["cf agent runner --work-root ", "dirs", undefined],
  ["cf space set-home ", "files", "*.tsx"],
  ["cf piece set-home ", "files", "*.tsx"],
  ["cf piece getsrc ", "files", undefined],
  ["cf deps update ", "files", undefined],
  ["cf fuse mount ", "dirs", undefined],
  ["cf fuse unmount ", "dirs", undefined],
  ["cf piece repair --fixer ", "files", "*.ts"],
  ["cf piece repair --plan ", "files", undefined],
  ["cf piece survey --diff ", "files", undefined],
  ["cf piece survey --validator ", "files", undefined],
  ["cf test --pattern-coverage-dir ", "dirs", undefined],
  ["cf test --timing-measures-out ", "files", undefined],
  ["cf fuse mount --cfc-writeback-state ", "files", undefined],
];

/** The commands each option provider answers on, or `null` for every one. */
const PROVIDER_SCOPES = completionProviderKeys().options;

/**
 * What a case has to name to pin this slot, keyed the way its provider varies.
 *
 * A positional provider is keyed by command path already, so one case pins one
 * command. An option provider that names the commands it answers on can answer
 * differently on each, so each of those is pinned on its own — which is what
 * `--from` and `--to` need, being a file and a directory on `space clone` and
 * sequence numbers on `inspect diff`. One that names no commands answers the
 * same wherever its option is declared, and the test below holds it to that,
 * so a single case covers every command at once.
 */
function providerKeyOf(line: CompletionLine): string | null {
  const slot = line.slot;
  const where = line.path.join(" ") || "<root>";
  if (slot?.kind === "argument") return `${where}:${slot.argument.name}`;
  if (slot?.kind !== "option-value") return null;
  const name = longName(slot.option);
  return (PROVIDER_SCOPES.get(name) ?? null) === null
    ? `--${name}`
    : `${where}:--${name}`;
}

/**
 * Whether the answer is a shell handoff and nothing else: one `files` or
 * `dirs` directive, no candidates. That is the half a fabric cannot change,
 * and so the half a unit test can pin.
 *
 * A `nospace` directive is not one. It accompanies live candidates to hold the
 * cursor mid-path, so what it comes with is exactly what a fabric changes, and
 * `completion-over-the-cli.sh` is where those slots are judged.
 */
function shellHandoff(
  result: { candidates: readonly unknown[]; directives: readonly Directive[] },
): Directive | null {
  if (result.candidates.length > 0 || result.directives.length !== 1) {
    return null;
  }
  const directive = result.directives[0];
  return directive.kind === "files" || directive.kind === "dirs"
    ? directive
    : null;
}

/**
 * The spelling that puts the cursor on an option's own value.
 *
 * An option whose value may be omitted never swallows the next word, so after
 * `--remote ` the cursor is on a positional and the slot being probed would be
 * somebody else's. `--remote=` is the spelling that reaches it, and the
 * declaration is what says which of the two an option needs.
 */
function optionProbeLine(
  name: string,
  where: string,
  optionalValues: ReadonlySet<string>,
): string {
  const path = where === "<root>" ? "" : `${where} `;
  return optionalValues.has(`${where}:--${name}`)
    ? `cf ${path}--${name}=`
    : `cf ${path}--${name} `;
}

/**
 * A line that puts the cursor on each slot the command tree declares. Only the
 * text: the key comes from the resolved line, so `providerKeyOf` is the one
 * place that says what a case has to name.
 */
function probeLines(): string[] {
  const slots = declaredSlots(main);
  const probes: string[] = [];
  for (const [name, paths] of slots.options) {
    for (const where of paths) {
      probes.push(optionProbeLine(name, where, slots.optionalValues));
    }
  }
  for (const slot of slots.positionals) {
    const path = slot.where === "<root>" ? "" : `${slot.where} `;
    // Earlier positionals have to be filled for the cursor to reach this one.
    const filled = Array.from({ length: slot.index }, (_, i) => `x${i} `).join(
      "",
    );
    probes.push(`cf ${path}${filled}`);
  }
  return probes;
}

/** How a slot answered, as a line of the report the tests below print. */
function handoffLabel(directive: Directive): string {
  const glob = (directive as { glob?: string }).glob;
  return glob ? `${directive.kind} ${glob}` : directive.kind;
}

Deno.test("live candidates: every path-shaped slot hands the shell its own directive", async () => {
  // These read no state, so this is where they belong — the integration
  // walkthrough covers the providers that reach a fabric and deliberately does
  // not re-check these.
  for (const [text, kind, glob] of DIRECTIVE_CASES) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.directives.length, 1, `${text} emits one directive`);
    const directive = result.directives[0] as { kind: string; glob?: string };
    assertEquals(directive.kind, kind, text);
    assertEquals(directive.glob, glob, `${text} glob`);
  }
});

Deno.test("provider keys report which commands each option provider answers on", () => {
  // What the slot gate subtracts from the command tree. An option keyed here
  // with no commands answers wherever it is declared; one keyed with commands
  // answers on those and is silent everywhere else, which is the difference
  // between a slot that was decided about and one that only looks decided.
  const { options, arguments: positionals } = completionProviderKeys();
  assertEquals(options.get("cell"), null);
  assertEquals(options.get("from"), ["space clone"]);
  assertEquals(options.get("to"), ["space clone"]);
  assertEquals(options.get("scope"), ["wish"]);
  assertEquals(options.get("list"), ["piece survey", "piece repair"]);
  assertEquals(options.get("diff"), ["piece survey"]);
  // Both projection flags answer on `get` alone. On `call` and `exec` they
  // name positions in a verb's result, and the piece's root is a different
  // value — so offering its fields there would offer plausible names for
  // something else, which is worse than offering none.
  // Both mounts: the superseded spelling still completes its own projection.
  assertEquals(options.get("select"), ["cell get", "get"]);
  assertEquals(options.get("schema"), ["cell get", "get"]);
  assertEquals(options.get("root"), [
    "check",
    "piece new",
    "piece set-home",
    "space set-home",
    "piece setsrc",
    "piece survey",
    "test",
    "inspect graph",
  ]);
  // `--accept-unretained` takes a row of the plan in hand, not a piece of the
  // registry: the registry omits the holder-created members a bulk operation
  // moves, and offers slugs the flag rejects outright. So the slot is decided
  // in NO_OPTION_CANDIDATES rather than provided here, and a provider keyed
  // for it would be offering a set that is wrong in both directions.
  assertFalse(options.has("accept-unretained"));
  // A positional entry is keyed by command path already, so it carries no
  // command list of its own.
  assert(positionals.has("call:callable"));
  assertFalse(positionals.has("callable"));
});

Deno.test("live candidates: every probe reaches the slot it was built for", () => {
  // What both nets below rest on. A probe that lands on a neighbouring slot
  // tests that neighbour and reports nothing about the slot it named, so the
  // net would pass over a whole class of options while looking exhaustive —
  // which is what the spaced spelling did to every optional-valued option,
  // whose flag does not swallow the word after it.
  const slots = declaredSlots(main);
  const wrong: string[] = [];
  for (const [name, paths] of slots.options) {
    for (const where of paths) {
      const text = optionProbeLine(name, where, slots.optionalValues);
      const line = lineFor(text);
      const reached = line.slot?.kind === "option-value" &&
        longName(line.slot.option) === name &&
        (line.path.join(" ") || "<root>") === where;
      if (!reached) wrong.push(`${text.trim()} misses ${where}:--${name}`);
    }
  }
  for (const slot of slots.positionals) {
    const path = slot.where === "<root>" ? "" : `${slot.where} `;
    const filled = Array.from({ length: slot.index }, (_, i) => `x${i} `).join(
      "",
    );
    const text = `cf ${path}${filled}`;
    const line = lineFor(text);
    const reached = line.slot?.kind === "argument" &&
      `${line.path.join(" ")}:${line.slot.argument.name}` === slot.key;
    if (!reached) wrong.push(`${text.trim()} misses ${slot.key}`);
  }
  assertEquals(wrong, []);
});

Deno.test("live candidates: no slot hands the shell a directive the cases miss", async () => {
  // The case table above is hand-maintained, and a hand-maintained table falls
  // behind the thing it describes without saying so — which is what it did
  // when four providers were added with no case. So the set is asked of the
  // code: every slot the tree declares is probed with no fabric configured,
  // and a shell handoff no case pins fails here rather than going unnoticed.
  //
  // The probe is keyed the way the provider varies, which is why a case on one
  // command does not vouch for a scoped provider's other commands. An
  // unscoped provider is vouched for by one case and held to answering the
  // same everywhere by the test below.
  const covered = new Set(
    DIRECTIVE_CASES.map(([text]) => providerKeyOf(lineFor(text))),
  );
  const missing: string[] = [];
  await withEnv({}, async () => {
    for (const text of probeLines()) {
      const line = lineFor(text);
      const handoff = shellHandoff(await liveCandidates(line));
      if (!handoff) continue;
      const key = providerKeyOf(line);
      if (key !== null && covered.has(key)) continue;
      missing.push(`${text.trim()} hands over ${handoffLabel(handoff)}`);
    }
  });
  assertEquals(missing, []);
});

Deno.test("live candidates: an unscoped option provider answers the same everywhere", async () => {
  // What makes one case cover every command declaring the option. A provider
  // that names no commands is a function of the line rather than of the path,
  // so a different answer on two commands means it is scoped in fact and not
  // in the table — the state `--root`, `--select` and `--schema` were in
  // before they said where they applied, and the state a single case cannot
  // pin.
  const answers = new Map<string, Map<string, string[]>>();
  const slots = declaredSlots(main);
  await withEnv({}, async () => {
    for (const [name, paths] of slots.options) {
      if ((PROVIDER_SCOPES.get(name) ?? null) !== null) continue;
      const byAnswer = new Map<string, string[]>();
      for (const where of paths) {
        const result = await liveCandidates(
          lineFor(optionProbeLine(name, where, slots.optionalValues)),
        );
        const handoff = shellHandoff(result);
        const answer = handoff
          ? handoffLabel(handoff)
          : result.candidates.length > 0
          ? "candidates"
          : "nothing";
        byAnswer.set(answer, [...(byAnswer.get(answer) ?? []), where]);
      }
      if (byAnswer.size > 1) answers.set(name, byAnswer);
    }
  });
  assertEquals(
    [...answers].map(([name, byAnswer]) =>
      `--${name}: ${
        [...byAnswer].map(([answer, where]) => `${answer} on ${where[0]}`)
          .join(", ")
      }`
    ),
    [],
  );
});

Deno.test("live candidates: an option that means two things is completed per command", async () => {
  // The option table is keyed by long name alone, so a slot answering by name
  // would hand the shell directory completion for a sequence number and for an
  // entity id. Offering the wrong set teaches the caller a word the command
  // rejects, which is worse than offering none.
  for (
    const text of [
      // A clone directory on `space clone`, a sequence number here.
      "cf inspect diff space entity --to ",
      // A snapshot file on `space clone`, a sequence number here.
      "cf inspect diff space entity --from ",
      // A wish search scope on `wish`, a scope key here.
      "cf inspect diff space entity --scope ",
      // A source directory on the commands that compile one, an entity here.
      // No space is named yet, so the entity provider has nothing to read —
      // which is the point: the slot reaches that provider, not the directory
      // one, and reads no disk to find out.
      "cf inspect graph --root ",
    ]
  ) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.directives.length, 0, `${text} emits no directive`);
    assertEquals(result.candidates.length, 0, `${text} offers no candidate`);
  }
});

Deno.test("an inspect entity slot reads the view its command will read", () => {
  // `--branch` and `--scope` choose which records the command resolves. A
  // listing taken from the space's default view would offer entities that read
  // is not going to find.
  assertEquals(entityListingView(lineFor("cf inspect diff space ")), {
    branch: undefined,
    scope: undefined,
    allScopes: false,
  });
  assertEquals(
    entityListingView(
      lineFor("cf inspect diff --branch draft --scope of:fid1:owner space "),
    ),
    { branch: "draft", scope: "of:fid1:owner", allScopes: false },
  );
  // `inspect overlay` declares no `--scope` and reports an entity's value in
  // every scope, so its slot covers them all rather than the default one.
  assertEquals(entityListingView(lineFor("cf inspect overlay space ")), {
    branch: undefined,
    scope: undefined,
    allScopes: true,
  });
});

/**
 * A space DB holding the given entities, each written once in its scope, with
 * its id as its value unless one is given. The default is one entity in the
 * default scope and one in another, so a listing taken from the wrong scope
 * offers the wrong id rather than none.
 */
function seedScopedSpace(
  path: string,
  entities: ReadonlyArray<
    readonly [id: string, scope: string, value?: string]
  > = [
    ["of:in-space", "space"],
    ["of:in-other", "other"],
  ],
): void {
  const db = new Database(path, { create: true });
  db.exec(`
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 0, 'active');`);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did%3Akey%3AzAlice:s1', ?, '{}', '{"seq":0}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, scope_key, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, ?, 0, 'set', ?, ?)`,
  );
  db.transaction(() => {
    entities.forEach(([id, scope, value = id], index) => {
      const seq = index + 1;
      commit.run(seq, seq);
      rev.run(id, scope, seq, JSON.stringify({ value }), seq);
    });
    db.prepare(`UPDATE branch SET head_seq = ? WHERE name = ''`)
      .run(entities.length);
  })();
  db.close();
}

Deno.test("live candidates: an entity slot lists the scope the line named", async () => {
  // The read the command will run is scoped, so the candidates have to be:
  // an id offered from the default scope is one that read cannot reach.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/space.sqlite`;
    seedScopedSpace(path);
    assertEquals(
      (await liveCandidates(lineFor(`cf inspect piece ${path} `)))
        .candidates.map((candidate) => candidate.value),
      ["of:in-space"],
    );
    assertEquals(
      (await liveCandidates(lineFor(`cf inspect piece ${path} --scope other `)))
        .candidates.map((candidate) => candidate.value),
      ["of:in-other"],
    );
    // `inspect overlay` reports an entity's value in EVERY scope and takes no
    // `--scope` to narrow it, so its slot covers every scope at once. Offering
    // only the space scope would hide exactly the per-user and per-session
    // entities the command exists to show.
    assertEquals(
      (await liveCandidates(lineFor(`cf inspect overlay ${path} `)))
        .candidates.map((candidate) => candidate.value).sort(),
      ["of:in-other", "of:in-space"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: the every-scope entity slot enumerates rows in one pass", async () => {
  // A row query filtered on one scope cannot seek (the revision index leads
  // with `id`), so it walks the whole branch; one per scope made completing
  // `inspect overlay` on a store of thousands of scopes take over an hour.
  const dir = await Deno.makeTempDir();
  const original = Database.prototype.prepare;
  let perScopeQueries = 0;
  const prepare = stub(
    Database.prototype,
    "prepare",
    function (this: Database, sql: string) {
      // The row enumeration, filtered to one scope. Reconstruction also
      // filters on a scope, alongside an `id` the index can seek on.
      if (/scope_key = \?/.test(sql) && /GROUP BY scope_key, id/.test(sql)) {
        perScopeQueries++;
      }
      return original.call(this, sql);
    },
  );
  try {
    const path = `${dir}/space.sqlite`;
    seedScopedSpace(
      path,
      Array.from({ length: 6 }, (_, i) => [`of:e${i}`, `scope-${i}`] as const),
    );
    const offered =
      (await liveCandidates(lineFor(`cf inspect overlay ${path} `)))
        .candidates.map((candidate) => candidate.value).sort();
    assertEquals(offered, [0, 1, 2, 3, 4, 5].map((i) => `of:e${i}`));
    assertEquals(perScopeQueries, 0);
  } finally {
    prepare.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: an entity in several scopes is offered once, with its space-scope label", async () => {
  // `inspect overlay` reads every scope, and one id can hold a value in each.
  // The id is offered once, labeled from the space scope, which is read first.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/space.sqlite`;
    seedScopedSpace(path, [
      ["of:shared", "other", "value-in-other"],
      ["of:shared", "space", "value-in-space"],
      ["of:only-other", "other"],
    ]);
    const offered =
      (await liveCandidates(lineFor(`cf inspect overlay ${path} `)))
        .candidates;
    assertEquals(
      offered.map((candidate) => candidate.value).sort(),
      ["of:only-other", "of:shared"],
    );
    const shared = offered.find((candidate) => candidate.value === "of:shared");
    assert(
      shared?.description?.includes("value-in-space"),
      `labeled from the space scope: ${shared?.description}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: a saturated space scope does not hide later scopes", async () => {
  // The scan cap bounds reconstruction, which only labels a candidate. A space
  // scope holding more than the cap spends all of it, and the per-user and
  // per-session entities after it — the ones `inspect overlay` exists to show
  // — are still offered, unlabeled.
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/space.sqlite`;
    const inSpace = DEFAULT_SCAN_LIMIT + 10;
    seedScopedSpace(path, [
      ...Array.from(
        { length: inSpace },
        (_, i) => [`of:s${i}`, "space"] as const,
      ),
      ...Array.from({ length: 20 }, (_, i) => [`of:o${i}`, "other"] as const),
    ]);
    const offered =
      (await liveCandidates(lineFor(`cf inspect overlay ${path} `)))
        .candidates;
    assertEquals(offered.length, inSpace + 20);
    assertEquals(
      offered.filter((candidate) => candidate.description !== undefined).length,
      DEFAULT_SCAN_LIMIT,
    );
    const values = new Set(offered.map((candidate) => candidate.value));
    for (let i = 0; i < 20; i++) assert(values.has(`of:o${i}`), `of:o${i}`);

    // What is typed narrows the rows before any is reconstructed, so a prefix
    // that matches fewer than the cap labels every one it offers.
    const narrowed = (await liveCandidates(
      lineFor(`cf inspect overlay ${path} of:o1`),
    )).candidates;
    assertEquals(
      narrowed.map((candidate) => candidate.value).sort(),
      ["of:o1", ...Array.from({ length: 10 }, (_, i) => `of:o1${i}`)].sort(),
    );
    assert(narrowed.every((candidate) => candidate.description !== undefined));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: an inspect line naming --remote offers nothing local", async () => {
  // `--remote` is global on `inspect` and decides where the space comes from:
  // `openByToken` resolves the token through the REMOTE's own listing and
  // opens the snapshot it fetches, so a locally discovered DID and the
  // entities of a local DB are both candidates the command rejects. Listing
  // the remote is a round trip a keystroke must not start, which leaves
  // nothing honest to offer. Both spellings count — the value is optional, so
  // the flag reaches the line as an option or as a bare flag.
  const dir = await Deno.makeTempDir();
  const saved = Deno.env.get("MEMORY_DIR");
  try {
    const did = "did:key:zCompletionRemoteFixture";
    const db = `${dir}/${did}.sqlite`;
    seedScopedSpace(db);
    Deno.env.set("MEMORY_DIR", dir);
    // Local mode answers each slot, which is what makes the silence below a
    // decision rather than a machine with nothing on it.
    assert(
      (await liveCandidates(lineFor("cf inspect summary "))).candidates
        .some((candidate) => candidate.value === did),
      "the space positional answers locally",
    );
    assert(
      (await liveCandidates(lineFor(`cf inspect piece ${db} `)))
        .candidates.length > 0,
      "the entity positional answers locally",
    );
    assert(
      (await liveCandidates(lineFor(`cf inspect graph ${db} --root `)))
        .candidates.length > 0,
      "graph --root answers locally",
    );
    for (
      const text of [
        "cf inspect summary --remote=http://remote.invalid ",
        "cf inspect summary --remote ",
        `cf inspect piece --remote=http://remote.invalid ${db} `,
        `cf inspect piece --remote ${db} `,
        `cf inspect graph --remote=http://remote.invalid ${db} --root `,
      ]
    ) {
      const result = await liveCandidates(lineFor(text));
      assertEquals(result.candidates, [], text);
      assertEquals(result.directives, [], text);
    }
  } finally {
    if (saved === undefined) Deno.env.delete("MEMORY_DIR");
    else Deno.env.set("MEMORY_DIR", saved);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: a remote-only space positional offers nothing local", async () => {
  // `inspect pull` names a space on the REMOTE and resolves it through the
  // remote's own listing, so a locally discovered DID is a candidate the
  // command rejects — while every sibling that opens a local space takes one.
  const dir = await Deno.makeTempDir();
  const saved = Deno.env.get("MEMORY_DIR");
  try {
    const did = "did:key:zCompletionPullFixture";
    await Deno.writeTextFile(`${dir}/${did}.sqlite`, "");
    Deno.env.set("MEMORY_DIR", dir);
    const listed = await liveCandidates(lineFor("cf inspect entities "));
    assert(
      listed.candidates.some((candidate) => candidate.value === did),
      "the local store is discoverable at all",
    );
    const pull = await liveCandidates(lineFor("cf inspect pull "));
    assertEquals(pull.candidates, []);
    assertEquals(pull.directives, []);
  } finally {
    if (saved === undefined) Deno.env.delete("MEMORY_DIR");
    else Deno.env.set("MEMORY_DIR", saved);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("live candidates: a fabric slot without context degrades to empty", async () => {
  // Mid-keystroke with nothing configured: silence, not an error.
  await withEnv({}, async () => {
    for (
      const text of [
        // The projection guards, which answer before any fabric is reached: a
        // call's projection names positions in a VERB's result rather than in
        // the piece's root, so the provider declines on those two commands,
        // and a `--schema` word opening with `@` or `{` is a file or a schema.
        // Each of these stands the cursor on the option's own value slot,
        // which is the only place a provider is looked up — past the `--` the
        // slot belongs to the read step, and nothing is consulted at all.
        // Which commands the provider answers on is pinned by the
        // provider-key test above.
        "cf piece call --piece x --select ",
        "cf exec --select ",
        "cf cell get --piece x --schema @",
        "cf cell get --piece x --schema {",
        "cf cell get-label --piece x ",
        "cf cell set-label --piece x ",
        "cf piece link ",
        "cf piece ls --piece ",
      ]
    ) {
      const result = await liveCandidates(lineFor(text));
      assertEquals(result.candidates.length, 0, text);
    }
  });
});

Deno.test("command: bash and zsh subcommands emit their scripts", async () => {
  const bash = await captureStdout(async () => {
    await main.parse(["completion", "bash"]);
  });
  assert(bash.includes("complete -o nospace -F _cf_complete cf"));

  const zsh = await captureStdout(async () => {
    await main.parse(["completion", "zsh"]);
  });
  assert(zsh.includes("#compdef cf"));
});

Deno.test("command: --no-deno-task reaches the script generator", async () => {
  const bash = await captureStdout(async () => {
    await main.parse(["completion", "bash", "--no-deno-task"]);
  });
  assert(bash.includes("complete -o nospace -F _cf_complete cf"));
  assert(!bash.includes("complete -F _cf_complete deno"));
});

Deno.test("command: complete accepts bash's raw line form", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "cf piece l",
      "--point",
      "10",
    ]);
  });
  assertEquals(out.split("\n").sort(), ["link", "ls"]);
});

Deno.test("command: complete accepts zsh's pre-tokenized form", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "zsh",
      "--cword",
      "2",
      "--",
      "cf",
      "piece",
      "l",
    ]);
  });
  // zsh output pairs each value with its description.
  const values = out.split("\n").map((line) => line.split(":")[0]).sort();
  assertEquals(values, ["link", "ls"]);
});

Deno.test("command: complete prints nothing when there is nothing to offer", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "cf piece zzzznomatch",
      "--point",
      "23",
    ]);
  });
  assertEquals(out, "");
});

Deno.test("command: malformed input never puts usage text on stdout", async () => {
  // Regression guard. stdout here is a data channel the shell reads on every
  // keystroke; Cliffy answers a malformed invocation by printing usage to
  // stdout, which the shell would then offer as candidates ("Usage:",
  // "-h, --help", ...). Raw-arg parsing is what prevents that.
  const malformed = [
    ["complete"], // no arguments at all
    ["complete", "--shell"], // flag with no value
    ["complete", "--line"], // the case Cliffy rejected outright
    ["complete", "--shell", "bash", "--line", "", "--point", "0"],
    ["complete", "--shell", "bash", "--line", "cf", "--point", "999"],
    ["complete", "--shell", "bash", "--point", "notanumber", "--line", "cf p"],
    ["complete", "--cword", "-4", "--", "cf", "piece"],
    ["complete", "--nonsense-flag", "value"],
  ];

  for (const args of malformed) {
    const out = await captureStdout(async () => {
      await main.parse(["completion", ...args]);
    });
    for (const line of out.split("\n").filter(Boolean)) {
      assert(
        !/^(Usage|Version|Description|Options|Commands):/.test(line) &&
          !line.includes("Show this help"),
        `usage text reached stdout for [${args.join(" ")}]: ${line}`,
      );
    }
  }
});

Deno.test("command: a deno line that is not ours is reported as such", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "deno test ",
      "--point",
      "10",
    ]);
  });
  assertEquals(out, ":cf:notmine");
});

Deno.test("shaping: equal document IDs preserve their distinct full target references", () => {
  const pieces = [
    { id: "fid1:same", reference: "//did:key:alpha/fid1:same@user/nested" },
    { id: "fid1:same", reference: "//did:key:beta/fid1:same" },
  ];
  assertEquals(
    shapePieceCandidates(pieces).map((row) => row.value),
    pieces.map((row) => row.reference),
  );
});

Deno.test("endpoint prefixes retain qualified scope and parent path", () => {
  const id = `fid1:${"a".repeat(43)}`;
  for (
    const root of [
      `/of:${id}`,
      `//did:key:foreign/of:${id}@user`,
      `/@did:key:foreign/of:${id}@user`,
    ]
  ) {
    assertEquals(splitPiecePathPrefix(root), undefined);
    assertEquals(splitPiecePathPrefix(`${root}/nested/fi`), {
      reference: `${root}/nested`,
      prefix: `${root}/nested/`,
    });
    assertEquals(splitPiecePathPrefix(`${root}/`), {
      reference: root,
      prefix: `${root}/`,
    });
  }
  for (const root of ["board", id]) {
    assertEquals(splitPiecePathPrefix(`${root}/nested/fi`), {
      reference: root,
      prefix: `${root}/nested/`,
      parentPath: "nested",
    });
  }
});

Deno.test("shaping: only default root references in the resolved listing space shorten", () => {
  const local = "did:key:local";
  const id = `fid1:${"a".repeat(43)}`;
  const pieces = [
    { id, reference: `//${local}/of:${id}@space` },
    { id, reference: `//did:key:foreign/of:${id}@space` },
    { id, reference: `//${local}/of:${id}@user` },
    { id, reference: `//${local}/of:${id}@space/nested` },
  ];
  assertEquals(shapePieceCandidates(pieces, local).map((row) => row.value), [
    id,
    ...pieces.slice(1).map((row) => row.reference),
  ]);
});

Deno.test("shaping: a piece is labeled by name, falling back to its pattern", () => {
  assertEquals(
    shapePieceCandidates([
      { id: "fid1:a", name: "Todo List" },
      { id: "fid1:b", patternRef: { symbol: "Bookmarks" } },
      { id: "fid1:c" },
      // A piece that failed to load still lists: its id is what an operator
      // reaches for completion to recover.
      { id: "fid1:d", patternRef: null },
    ]),
    [
      { value: "fid1:a", description: "Todo List" },
      { value: "fid1:b", description: "Bookmarks" },
      { value: "fid1:c", description: undefined },
      { value: "fid1:d", description: undefined },
    ],
  );
});

Deno.test("shaping: a callable is annotated with what the author said it is for", () => {
  // The doc comment is the sentence the verb's help page opens with, and the
  // kind is a two-value fact that rarely decides anything at the prompt. The
  // kind is the fallback where the author documented nothing, so a candidate
  // is never unannotated.
  assertEquals(
    shapeVerbCandidates([
      { name: "addItem", kind: "handler", description: "Add one item." },
      { name: "search", kind: "tool" },
      { name: "wrapped", kind: "handler", description: "  " },
    ]),
    [
      { value: "addItem", description: "Add one item." },
      { value: "search", description: "tool" },
      { value: "wrapped", description: "handler" },
    ],
  );
});

Deno.test("shaping: a callable takes the first line of a multi-line comment", () => {
  // The annotation is one column of one row; the rest of the comment is what
  // the verb's own help page is for.
  assertEquals(
    shapeVerbCandidates([
      {
        name: "noteAll",
        kind: "handler",
        description: "Record it.\nThen some.",
      },
    ])[0].description,
    "Record it.",
  );
});

Deno.test("shaping: a verb carrying both marks is offered with both", () => {
  // The marks can coexist, and `cf piece verbs` renders them joined — so
  // picking one would put the two surfaces back into the silent disagreement
  // this mark exists to end.
  assertEquals(
    shapeVerbCandidates([
      {
        name: "openLegacy",
        kind: "handler",
        tier: "wrapper",
        deprecated: true,
        description: "Open it.",
      },
    ]),
    [{ value: "openLegacy", description: "[wrapper,deprecated] Open it." }],
  );
});

Deno.test("shaping: a verb the listing holds back is offered marked", () => {
  // `cf piece verbs` hides both unless --all. Both are callable, so hiding
  // them here would put a working name out of reach; the mark is what keeps
  // the two surfaces from disagreeing silently.
  assertEquals(
    shapeVerbCandidates([
      { name: "legacyAdd", kind: "handler", deprecated: true },
      {
        name: "openPicker",
        kind: "handler",
        tier: "wrapper",
        description: "Pick.",
      },
      { name: "addItem", kind: "handler", deprecated: false },
    ]),
    [
      { value: "legacyAdd", description: "[deprecated] handler" },
      { value: "openPicker", description: "[wrapper] Pick." },
      { value: "addItem", description: "handler" },
    ],
  );
});

Deno.test("shaping: a slug is labeled apart from the ids beside it", () => {
  // Both are `--piece` values, so a candidate list mixing them has to say
  // which is which — and where the slug resolves to a piece the listing named,
  // what it points at is the question a caller is actually asking.
  assertEquals(
    shapeSlugCandidates(
      [
        { slug: "board", piece: "fid1:a" },
        { slug: "orphan", piece: "fid1:missing" },
        { slug: "unresolved" },
      ],
      [{ id: "fid1:a", name: "Completion fixture" }],
    ),
    [
      { value: "board", description: "slug for Completion fixture" },
      { value: "orphan", description: "slug" },
      { value: "unresolved", description: "slug" },
    ],
  );
});

Deno.test("shaping: a projection word splits into the part carried back and the path", () => {
  // The shell replaces the whole word, so a candidate has to carry every
  // element already closed and every segment already typed in this one.
  assertEquals(splitSelectPrefix(""), {
    list: "",
    path: [],
    prefix: "",
    atElementStart: true,
  });
  assertEquals(splitSelectPrefix("settings."), {
    list: "",
    path: ["settings"],
    prefix: "settings.",
    atElementStart: false,
  });
  assertEquals(splitSelectPrefix("items@,settings.the"), {
    list: "items@,",
    path: ["settings"],
    prefix: "settings.",
    atElementStart: false,
  });
  assertEquals(splitSelectPrefix("revision,"), {
    list: "revision,",
    path: [],
    prefix: "",
    atElementStart: true,
  });
});

Deno.test("shaping: a projection path reads through however many array layers it meets", () => {
  // `--select matrix.nested.leaf` is valid over `[[{nested: {leaf}}]]`, so a
  // walk that unwrapped one layer would offer `nested` and then nothing.
  const nested = { matrix: [[{ nested: { leaf: 1 } }]] };
  assertEquals(projectionKeys(descendProjection(nested, ["matrix"])), [
    "nested",
  ]);
  assertEquals(
    projectionKeys(descendProjection(nested, ["matrix", "nested"])),
    ["leaf"],
  );
});

Deno.test("shaping: the bare address suffix is offered at any element of the list", () => {
  // `revision,@` parses: a path that is only the suffix is legal wherever an
  // element begins, not only at the first.
  assertEquals(
    shapeProjectionCandidates({ a: 1 }, "revision,", { self: true })[0].value,
    "revision,@",
  );
});

Deno.test("shaping: a projection path reads an array element-wise", () => {
  // `--select items.title` projects each element; `--select items.0.title` is
  // refused. Offering an index would name a path the command rejects.
  assertEquals(
    projectionKeys(descendProjection(
      { items: [{ title: "a" }, { title: "b", pinned: true }] },
      ["items"],
    )),
    ["title", "pinned"],
  );
  assertEquals(projectionKeys([{ a: 1 }, { b: 2 }]), ["a", "b"]);
  assertEquals(projectionKeys({ a: 1 }), ["a"]);
  for (const leaf of ["text", 42, true, null, undefined]) {
    assertEquals(projectionKeys(leaf), [], String(leaf));
  }
});

Deno.test("shaping: both spellings of a position are offered, each carrying the prefix", () => {
  assertEquals(
    shapeProjectionCandidates({ theme: "dark" }, "settings."),
    [
      { value: "settings.theme" },
      { value: "settings.theme@", description: "its address" },
    ],
  );
});

Deno.test("shaping: the bare address suffix is offered only where it is asked for", () => {
  const withSelf = shapeProjectionCandidates({ a: 1 }, "", { self: true });
  assertEquals(withSelf[0].value, "@");
  assertEquals(
    shapeProjectionCandidates({ a: 1 }, "").map((c) => c.value),
    ["a", "a@"],
  );
});

Deno.test("shaping: an address-marked segment keeps completing below it", () => {
  // `topic@.title` marks `topic` and projects `title`, so the walk reads the
  // field the segment NAMES while the candidate carries the marker back.
  assertEquals(splitSelectPrefix("topic@.").path, ["topic"]);
  assertEquals(splitSelectPrefix("topic@.").prefix, "topic@.");
  assertEquals(
    projectionKeys(descendProjection({ topic: { title: 1 } }, ["topic"])),
    ["title"],
  );
  // An escaped `@` is part of the name, not the marker.
  assertEquals(splitSelectPrefix("a\\@.").path, ["a@"]);
});

Deno.test("acceptedProjections keeps what the flag's own parser reads as a field list", async () => {
  // The filter itself, driven directly: a spelling each flag refuses, one it
  // reads as something other than a field list, and one it takes.
  const shape = (values: string[]) => values.map((value) => ({ value }));
  assertEquals(
    (await acceptedProjections(
      shape(["@", "revision,@", "ok"]),
      "select",
    )).map((candidate) => candidate.value),
    ["@", "revision,@", "ok"],
  );
  // `--schema @` is an empty file path; `--schema true` parses, but as the
  // boolean JSON Schema rather than a field list.
  assertEquals(
    (await acceptedProjections(
      shape(["@", "true", "revision,@", "ok"]),
      "schema",
    )).map((candidate) => candidate.value),
    ["revision,@", "ok"],
  );
});

Deno.test("the projection grammar decides which candidates a flag can take", async () => {
  // The boundary cases, each settled by the flag's own parser rather than by
  // a rule restated here. A candidate that parses but comes back as something
  // other than a field list — `--schema true` is the boolean JSON Schema — is
  // not a candidate for this slot either.
  const shaped = (prefix: string) =>
    shapeProjectionCandidates({ "true": 1, "false": 2, ok: 3 }, prefix, {
      self: true,
    }).map((candidate) => candidate.value);
  const accepted = async (flag: "select" | "schema", prefix: string) => {
    const kept: string[] = [];
    for (const value of shaped(prefix)) {
      try {
        const parsed = flag === "select"
          ? parseSelectProjection(value)
          : await parseSelectionProjection(value);
        if (parsed.kind === "concise") kept.push(value);
      } catch {
        // refused by this flag
      }
    }
    return kept;
  };

  // `--select` takes a bare `@` at the first element; `--schema` reads a
  // leading `@` as a file path and so does not.
  assert((await accepted("select", "")).includes("@"));
  assertFalse((await accepted("schema", "")).includes("@"));
  // After a comma neither is leading, so both take it.
  assert((await accepted("select", "revision,")).includes("revision,@"));
  assert((await accepted("schema", "revision,")).includes("revision,@"));
  // `true` alone is a whole-value schema to one flag and refused by the
  // other, and an ordinary field name to both once it is not alone.
  assertFalse((await accepted("select", "")).includes("true"));
  assertFalse((await accepted("schema", "")).includes("true"));
  assert((await accepted("select", "revision,")).includes("revision,true"));
  assert((await accepted("schema", "revision,")).includes("revision,true"));
});

Deno.test("shaping: a key the concise grammar cannot carry is not offered", () => {
  // `parseConciseSegment` holds a segment to an identifier grammar, and a
  // trailing `@` in a name reads as the address suffix. Offering either would
  // name a path the command refuses.
  assertEquals(
    shapeProjectionCandidates({ "ok": 1, "not ok": 2, "trailing@": 3 }, "")
      .map((candidate) => candidate.value),
    ["ok", "ok@"],
  );
});

Deno.test("shaping: an entity is labeled by what was reconstructed for it", () => {
  // The id is what the next positional takes; the label is what makes it
  // readable. `(piece)` is what the reconstruction says when it found no name,
  // which is the kind's job rather than the label's.
  assertEquals(
    shapeEntityCandidates([
      { id: "of:fid1:a", label: "Completion fixture", kind: "piece" },
      { id: "of:fid1:b", label: "(piece)", kind: "piece" },
      { id: "of:fid1:c", kind: "free-cell" },
    ]),
    [
      { value: "of:fid1:a", description: "Completion fixture" },
      { value: "of:fid1:b", description: "piece" },
      { value: "of:fid1:c", description: "free-cell" },
    ],
  );
});

Deno.test("every wish target offered is one the command's help enumerates", () => {
  // The vocabulary is the wish builtin's rather than the command tree's, so it
  // is carried here by hand. The help text is where it is documented, and a
  // target in one and not the other is the drift this catches.
  //
  // Whole words, not substrings: the help enumerates `#profileName` as well as
  // `#profile`, so a substring test would keep passing after `#profile` itself
  // was dropped from the help — the one drift most likely to happen.
  const documented = new Set(wish.getDescription().split(/\s+/));
  for (const candidate of wishTargetCandidates().candidates) {
    assert(
      documented.has(candidate.value),
      `${candidate.value} is offered but not documented in cf wish --help`,
    );
  }
});

Deno.test("shaping: a typed path splits into parent and replacement prefix", () => {
  // The prefix is what stops a completed deep path collapsing to its last
  // segment — the shell replaces the whole word.
  assertEquals(splitPathPrefix("items"), { parentPath: "", prefix: "" });
  assertEquals(splitPathPrefix("items/"), {
    parentPath: "items",
    prefix: "items/",
  });
  assertEquals(splitPathPrefix("items/0/ti"), {
    parentPath: "items/0",
    prefix: "items/0/",
  });
});

Deno.test("shaping: a piece-and-path prefix never doubles the separator", () => {
  // `id//key` would be a different, invalid reference.
  assertEquals(pieceWithPathPrefix("fid1:a", ""), "fid1:a/");
  assertEquals(pieceWithPathPrefix("fid1:a", "items"), "fid1:a/items/");
  assertEquals(pieceWithPathPrefix("fid1:a", "items/0"), "fid1:a/items/0/");
});

Deno.test("live candidates preserve qualified space, user scope, and nested paths", async () => {
  const identity = await Identity.fromPassphrase(
    "completion qualified viewer",
    { implementation: "noble" },
  );
  const foreign = await Identity.fromPassphrase("completion foreign space");
  const storage = StorageManager.emulate({ as: identity });
  const keyPath = await Deno.makeTempFile();
  await Deno.writeFile(keyPath, identity.toPkcs8());
  const piece = entityIdFrom(taggedHashStringOf("completion-qualified-piece"));
  const reference = `/@${foreign.did()}/of:${piece.toString()}@user/items/0/`;
  const runtimes: Runtime[] = [];
  const openedSpaces: string[] = [];
  const open = stub(WorkerStorageManager, "open", () => storage);
  const fetchMeta = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(Response.json({ experimental: {} })),
  );
  const health = stub(Runtime.prototype, "healthCheck", async function () {
    runtimes.push(this);
    const addressed = this.getCellFromEntityId(
      foreign.did(),
      piece,
      [],
      undefined,
      undefined,
      "user",
    );
    const otherScope = this.getCellFromEntityId(foreign.did(), piece);
    const otherSpace = this.getCellFromEntityId(
      identity.did(),
      piece,
      [],
      undefined,
      undefined,
      "user",
    );
    await Promise.all([addressed.sync(), otherScope.sync(), otherSpace.sync()]);
    for (
      const [cell, value] of [
        [addressed, {
          items: [{ title: "target", detail: "target" }],
          rootDecoy: true,
        }],
        [otherScope, { items: [{ wrongScope: true }] }],
        [otherSpace, { items: [{ wrongSpace: true }] }],
      ] as const
    ) {
      const tx = this.edit();
      cell.withTx(tx).set(value);
      await tx.commit();
    }
    return true;
  });
  const session = stub(
    PiecesController.prototype,
    "ensureSpaceSession",
    function () {
      openedSpaces.push(this.getSpace());
      return Promise.resolve();
    },
  );
  resetProcessDeployment();
  try {
    await withEnv(
      { identity: keyPath, apiUrl: "http://127.0.0.1:1" },
      async () => {
        const result = await liveCandidates(
          lineFor(`cf piece link ${reference}ti`),
        );
        expect(result).toEqual({
          candidates: [{ value: `${reference}title` }, {
            value: `${reference}detail`,
          }],
          directives: [{ kind: "nospace" }],
        });
        expect(openedSpaces).toEqual([foreign.did()]);
      },
    );
  } finally {
    session.restore();
    health.restore();
    fetchMeta.restore();
    open.restore();
    for (const runtime of runtimes) await runtime.dispose();
    await storage.close();
    await Deno.remove(keyPath);
    resetProcessDeployment();
  }
});
