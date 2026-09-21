#!/usr/bin/env -S deno run --allow-read --allow-env --allow-sys --allow-ffi

/**
 * Fails when a slot the CLI accepts has not been decided about for completion.
 *
 * Completion trails the command surface, and it does so silently. The resolver
 * walks the live Cliffy tree, so a new subcommand or flag becomes completable
 * the moment it is registered; its VALUES do not, because they come from two
 * hand-maintained tables. A command reaching the tree with no entry in either
 * is indistinguishable at the prompt from one whose fabric is unreachable —
 * both offer nothing — so the drift never announces itself.
 *
 * Both provider tables answer in command paths, and both are derivable from
 * the same tree the resolver walks: a positional entry is keyed by
 * `<command path>:<argument name>`, and an option entry carries the commands
 * its provider answers on wherever it answers on some of them. So the drift is
 * machine-detectable, in three directions:
 *
 * - A slot with no provider, no enumerated set, and no allowlist entry.
 * - A provider entry matching no slot on the tree — the same subtraction run
 *   the other way, which is what found `log-file` and `state-path` belonging
 *   to commands that declare no Cliffy options at all.
 * - An allowlist entry that decides no slot, so the record of a decision
 *   cannot outlive the thing it was about.
 *
 * A slot is one option ON one command, not one option name: `--from` is a
 * snapshot file on `space clone` and a sequence number on `inspect diff`, and
 * a provider for the first says nothing about the second.
 *
 * What this cannot decide is whether a slot SHOULD complete — plenty should
 * not. What it requires is that every slot has been decided about, which is
 * what the allowlists record. That turns the next command's completion from
 * something remembered into something the gate asks for.
 *
 * Usage: deno task check-completion-slots
 *        deno task check-completion-slots --list   # every undecided slot
 */

import { main as cliRoot } from "../packages/cli/commands/main.ts";
import {
  type AnyCommand,
  type DeclaredSlots,
  declaredSlots,
} from "../packages/cli/lib/completion/line.ts";
import { enumeratedOptionNames } from "../packages/cli/lib/completion/static.ts";
import { completionProviderKeys } from "../packages/cli/lib/completion/providers.ts";

/**
 * Positionals deliberately left without candidates, each with the reason.
 *
 * A reason here answers one question: what would the candidates BE? A value a
 * caller pastes from elsewhere, a word they are coining, or a number has no set
 * to draw from, and offering a wrong one is worse than offering none.
 */
export const NO_CANDIDATES = new Map<string, string>([
  [
    "space invite redeem:invite-id",
    "an opaque invitation ID supplied with the code",
  ],
  [
    "space invite revoke:invite-id",
    "an opaque ID from invitation creation or listing",
  ],
  [
    "space invite receipts:invite-id",
    "an opaque ID from invitation creation or listing",
  ],
  // Values a caller brings from outside the CLI.
  ["acl set:did", "a DID being granted access; nothing here enumerates them"],
  ["acl remove:did", "the same DID, and the same absence of a source"],
  ["inspect identity:did", "a DID to look up, pasted from elsewhere"],
  ["id derive:passphrase", "a secret; a candidate list is the wrong place"],
  ["id from-mnemonic:mnemonic", "the same"],
  ["ingest revoke:id", "an ingest key id, held by whoever minted it"],
  ["ingest rotate:id", "the same"],
  // Words the caller is coining or composing.
  ["acl set:capability", "a capability string, composed rather than chosen"],
  ["piece search:query", "a search query"],
  ["profile create:name", "a display name the caller is coining"],
  [
    "piece follow:origin",
    "a source origin the caller names, such as a `system:` ref",
  ],
  // Words that belong to a callable rather than to the CLI: the verb opens the
  // callable's section, so its own vocabulary fills this positional. Item 4 of
  // docs/plans/cli-completion-coverage.md builds the candidates and is what
  // will route them here.
  ["piece call:tail", "the callable's own vocabulary"],
  ["call:tail", "the same, under the superseded spelling"],
  ["exec:tail", "the same"],
]);

/**
 * Options deliberately left without candidates.
 *
 * The same question, answered per option: an entry here is a value with no set
 * to draw from, or one whose set would cost more to derive than the keystrokes
 * it saves.
 *
 * A bare long name decides the option wherever it is declared, and is honest
 * only where nothing provides it anywhere. An option a provider answers on one
 * command means something else on the rest, so those are decided one at a time
 * under `<command path>:<long name>`.
 */
export const NO_OPTION_CANDIDATES = new Map<string, string>([
  [
    "profile repair-name-protection:expect",
    "the receipt from the owner-reviewed inspection",
  ],
  ["piece new:request-key", "an opaque caller retry key"],
  ["space invite create:ttl", "an admission lifetime in seconds"],
  ["space invite create:max-uses", "a distinct identity count"],
  ["space invite create:shell", "a caller-selected shell origin"],
  [
    "space invite create:request-file",
    "a private creation request path, supplied explicitly",
  ],
  [
    "space invite redeem:code-file",
    "a secret input path or stdin marker, supplied explicitly",
  ],
  // Numbers, durations and bounds. Nothing enumerates a count.
  ["limit", "a row count"],
  ["depth", "a graph depth"],
  ["seq", "a revision sequence number"],
  ["top", "a result count"],
  ["bucket", "a time bucket size"],
  ["since", "a timestamp"],
  ["until", "a timestamp"],
  ["ttl-days", "a lifetime in days"],
  ["attrcache-timeout", "a timeout in seconds, passed to the FUSE child"],
  ["stats-action-limit", "a count"],
  ["stats-threshold", "a threshold"],
  ["storage-stats-limit", "a count"],
  ["wait", "a patience in seconds"],
  ["group-size", "how many pieces one session serves; a count"],
  ["history-limit", "an operation history row count"],
  ["max-concurrent", "how many agent runs one runner holds; a count"],
  ["lease-seconds", "a lease length in seconds"],
  ["submission-after-seq", "a revision sequence number"],
  // Identifiers the caller brings from outside, or coins.
  ["did", "a DID, pasted from elsewhere"],
  ["as", "a DID whose view to approximate, pasted from elsewhere"],
  ["slug", "a slug being coined for the first time"],
  ["invocation", "the caller's own word for one call"],
  ["invocation-session", "an unguessable session string"],
  ["install-id", "the caller's own installation identifier"],
  ["cause-prefix", "a prefix the caller chooses"],
  ["name", "a name the caller chooses"],
  ["session", "a session id, read out of the data being inspected"],
  [
    "revision",
    "a revision id from one piece's own source log, read off the listing " +
    "`cf piece restore` prints for it",
  ],
  [
    "accept-unretained",
    "a piece address out of the run's own unretained refusal — the rows of " +
    "the plan in hand whose prior source is not retained, which the piece " +
    "registry neither holds nor bounds: it omits the holder-created members " +
    "a bulk operation moves, and its slugs are not addresses this flag takes",
  ],
  ["branch", "a branch name; the default is the empty one"],
  ["cfc-xattr-namespace", "a namespace the caller chooses"],
  // Expressions and lists with their own grammar.
  ["filter", "a jq-inspired predicate expression"],
  ["path", "a cell path relative to a target the flag does not name"],
  ["path-json", "the same path written as a JSON array"],
  ["spaces", "a comma-separated list of the tokens --space takes"],
  ["stats-include", "a comma-separated list of timing categories"],
  [
    "tools",
    "a comma-separated list of the tool names a runner offers, which the " +
    "harness backing it decides and the CLI does not enumerate",
  ],
  ["import", "an import specifier"],
  [
    "retarget",
    "a `<phase>=<main.tsx>[@rev]` spec, composed rather than chosen",
  ],
  // Values naming something outside the fabric.
  ["url", "a browser URL; its parts complete as --api-url, --space, --piece"],
  ["app-url", "a shell origin, which is not the api-url --api-url names"],
  ["repository", "a source repository URL"],
  ["model", "a model name the harness's configured provider defines"],
  [
    "main-export",
    "an export name inside a pattern file, which needs the file compiled",
  ],
  ["filename", "a display name for what `cf view` is rendering"],
  // The commands where an option a provider answers elsewhere means something
  // else. `--from` and `--to` bound a range of commits here, where on
  // `space clone` they name a snapshot file and a destination directory.
  ["inspect diff:from", "a revision sequence number"],
  ["inspect diff:to", "the same"],
  // A raw scope key: `space`, `user:<did>`, or `session:<did>:<uuid>`, read
  // out of the data being inspected — the disposition `--session`, which
  // names the last of those parts, already carries. `inspect converge` reads
  // across spaces, so it has no single store to read them from at all.
  ["inspect conflicts:scope", "a stored scope key, read out of the data"],
  ["inspect converge:scope", "the same, across every space compared"],
  ["inspect diff:scope", "the same"],
  ["inspect graph:scope", "the same"],
  ["inspect history:scope", "the same"],
  ["inspect html:scope", "the same"],
  ["inspect operations:scope", "the same"],
  ["inspect piece:scope", "the same"],
  ["inspect timeline:scope", "the same"],
  ["inspect value-at:scope", "the same"],
  // A projection into a VERB's result rather than into the value at a target,
  // so its vocabulary is the verb's `outputSchema`. Written past the `--` that
  // closes the callable's section, so the verb already precedes the cursor.
  // Item 6 of docs/plans/cli-completion-coverage.md is what builds it.
  ["piece call:select", "the verb's own result shape"],
  ["piece call:schema", "the same"],
  ["call:select", "the same, under the superseded spelling"],
  ["call:schema", "the same"],
  ["exec:select", "the same"],
  ["exec:schema", "the same"],
  // `wish` projects what its query resolved to, and resolving a wish commits a
  // cell to the space: a Tab must not write. Item 5's `wish` half, declined.
  ["wish:select", "a resolution a Tab must not make"],
  ["wish:schema", "the same"],
]);

/** What the check found, in the three directions it looks. */
export interface SlotReport {
  /**
   * Option slots — one option on one command — with no provider, no
   * enumerated set, and no allowlist entry.
   */
  readonly undecidedOptions: string[];

  /** Positionals with no provider and no allowlist entry. */
  readonly undecidedPositionals: string[];

  /** Provider entries matching no slot on the tree. */
  readonly unreachableProviders: string[];

  /** Allowlist entries that decide no slot on the tree. */
  readonly staleAllowlist: string[];
}

/** An option slot as a failure line reads it: the flag, and where it is. */
function optionSlotLabel(name: string, where: string): string {
  return `--${name}  (${where})`;
}

/** An option allowance as a failure line reads it, in either key form. */
function allowanceLabel(key: string): string {
  const cut = key.indexOf(":");
  return cut === -1
    ? `--${key}`
    : optionSlotLabel(key.slice(cut + 1), key.slice(0, cut));
}

/** Subtract what completion decides about from what the tree declares. */
export function reportSlots(
  declared: DeclaredSlots,
  known: {
    /**
     * Option long name -> the command paths its provider answers on, or `null`
     * where it answers on every command declaring the option.
     */
    readonly providerOptions: ReadonlyMap<string, readonly string[] | null>;

    readonly providerArguments: ReadonlySet<string>;
    readonly enumerated: ReadonlySet<string>;
    readonly allowedOptions: ReadonlySet<string>;
    readonly allowedPositionals: ReadonlySet<string>;
  },
): SlotReport {
  // Every allowance that turned out to answer a slot. What is left over is a
  // decision about something that is no longer there to decide.
  const spent = new Set<string>();

  const undecidedOptions: string[] = [];
  for (const [name, paths] of [...declared.options].sort()) {
    const provided = known.providerOptions.get(name);
    for (const where of [...paths].sort()) {
      if (
        provided !== undefined &&
        (provided === null || provided.includes(where))
      ) {
        continue;
      }
      if (known.enumerated.has(name)) continue;
      const scoped = `${where}:${name}`;
      if (known.allowedOptions.has(scoped)) {
        spent.add(scoped);
        continue;
      }
      // A bare name decides the option across the whole tree, which is only
      // honest where nothing provides it anywhere: an option a provider
      // answers on one command has to be decided per command on the rest.
      if (provided === undefined && known.allowedOptions.has(name)) {
        spent.add(name);
        continue;
      }
      undecidedOptions.push(optionSlotLabel(name, where));
    }
  }

  const undecidedPositionals: string[] = [];
  for (
    const slot of [...declared.positionals].sort((a, b) =>
      a.key.localeCompare(b.key)
    )
  ) {
    if (known.providerArguments.has(slot.key)) continue;
    if (known.allowedPositionals.has(slot.key)) {
      spent.add(slot.key);
      continue;
    }
    undecidedPositionals.push(slot.key);
  }

  const positionalKeys = new Set(
    declared.positionals.map((slot) => slot.key),
  );
  const unreachableProviders: string[] = [];
  for (const [name, paths] of known.providerOptions) {
    const declaredOn = declared.options.get(name);
    if (!declaredOn) {
      unreachableProviders.push(`--${name}`);
      continue;
    }
    for (const path of paths ?? []) {
      if (!declaredOn.includes(path)) {
        unreachableProviders.push(optionSlotLabel(name, path));
      }
    }
  }
  for (const key of known.providerArguments) {
    if (!positionalKeys.has(key)) unreachableProviders.push(key);
  }

  const staleAllowlist: string[] = [];
  for (const key of known.allowedPositionals) {
    if (!spent.has(key)) staleAllowlist.push(key);
  }
  for (const key of known.allowedOptions) {
    if (!spent.has(key)) staleAllowlist.push(allowanceLabel(key));
  }

  return {
    undecidedOptions,
    undecidedPositionals,
    unreachableProviders: unreachableProviders.sort(),
    staleAllowlist: staleAllowlist.sort(),
  };
}

/** The failures a report describes, one paragraph each. */
export function describeFailures(report: SlotReport): string[] {
  const failures: string[] = [];
  const block = (lines: readonly string[]) =>
    lines.map((line) => `  ${line}`).join("\n");
  if (report.undecidedOptions.length > 0) {
    failures.push(
      `${report.undecidedOptions.length} value-taking option slot(s) have no ` +
        `provider, no enumerated set, and no entry in NO_OPTION_CANDIDATES:\n` +
        block(report.undecidedOptions),
    );
  }
  if (report.undecidedPositionals.length > 0) {
    failures.push(
      `${report.undecidedPositionals.length} positional(s) have no provider ` +
        `and no entry in NO_CANDIDATES:\n` +
        block(report.undecidedPositionals),
    );
  }
  if (report.unreachableProviders.length > 0) {
    failures.push(
      `${report.unreachableProviders.length} provider entr(ies) match no slot ` +
        `on the command tree:\n` + block(report.unreachableProviders),
    );
  }
  if (report.staleAllowlist.length > 0) {
    failures.push(
      `${report.staleAllowlist.length} allowlist entr(ies) decide no slot:\n` +
        block(report.staleAllowlist),
    );
  }
  return failures;
}

/**
 * Run the check against a command tree — the CLI's own unless another is given
 * — and return the process exit code.
 */
export function main(
  args: readonly string[] = [],
  root: AnyCommand = cliRoot,
): number {
  const declared = declaredSlots(root);
  const providers = completionProviderKeys();
  const report = reportSlots(declared, {
    providerOptions: providers.options,
    providerArguments: providers.arguments,
    enumerated: enumeratedOptionNames(),
    allowedOptions: new Set(NO_OPTION_CANDIDATES.keys()),
    allowedPositionals: new Set(NO_CANDIDATES.keys()),
  });

  if (args.includes("--list")) {
    console.log("Undecided options:");
    for (const line of report.undecidedOptions) console.log(`  ${line}`);
    console.log("Undecided positionals:");
    for (const line of report.undecidedPositionals) console.log(`  ${line}`);
    return 0;
  }

  const failures = describeFailures(report);
  if (failures.length > 0) {
    console.error("Completion slot check failed.\n");
    console.error(failures.join("\n\n"));
    console.error(
      "\nEither give the slot candidates in packages/cli/lib/completion/, or " +
        "record why it has none in tasks/check-completion-slots.ts — under " +
        "`<command path>:<name>` where the option means something else " +
        "elsewhere.",
    );
    return 1;
  }

  let optionSlots = 0;
  for (const paths of declared.options.values()) optionSlots += paths.length;
  console.log(
    `Completion slots OK (${optionSlots} option slot(s) over ` +
      `${declared.options.size} name(s), ${declared.positionals.length} ` +
      `positional(s)).`,
  );
  return 0;
}

if (import.meta.main) Deno.exit(main(Deno.args));
