import { Command, ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { type DIDKey, encodeDelegationChains } from "@commonfabric/identity";
import { isDIDKey } from "@commonfabric/identity/did";
import type { MemorySpace } from "@commonfabric/runner";

import { cliText } from "../lib/cli-name.ts";
import {
  describeDelegationChains,
  issueDelegationChain,
  readDelegationChainFile,
} from "../lib/delegation.ts";
import { loadIdentity } from "../lib/identity.ts";
import {
  type IndexDelegationKind,
  issueIndexDelegation,
} from "../lib/index-delegation.ts";
import { resolvePatternIndexUrl } from "@commonfabric/pattern-index/access";
import { loadPieces, type SpaceConfig } from "../lib/piece.ts";
import { render } from "../lib/render.ts";
import {
  parseSpaceOptions,
  type PieceCLIOptions,
  targetOptions,
} from "./piece.ts";

/** What `cf delegation issue` takes beyond the target options. */
interface IssueOptions extends PieceCLIOptions {
  /** The DID of the key being delegated to. */
  to: string;

  /** How long the delegation holds, in seconds; forever when absent. */
  expiresIn?: number;

  /** Where to write the chain file; stdout when absent. */
  out?: string;

  /** Delegate pattern-index membership (`/index`) rather than a space. */
  index?: boolean;

  /** Delegate the single-use `/index/root` that moves the member's root. */
  indexRoot?: boolean;

  patternIndexUrl?: string;
}

/** The time a `--expires-in` counts from, read once per command. */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** What `cf delegation issue` reads of the connection to the space. */
export interface IssueConnection {
  getSpace(): MemorySpace;
  runtime: {
    storageManager: {
      delegationChainFor?(
        space: MemorySpace,
      ): readonly Uint8Array[] | undefined;
    };
  };
  dispose(): Promise<void>;
}

/**
 * `cf delegation issue`: the chain the key `--to` names presents to open the
 * space, written to `--out` or stdout, over the connection `load` opens.
 */
export async function delegationIssueAction(
  options: IssueOptions,
  load: (config: SpaceConfig) => Promise<IssueConnection> = loadPieces,
): Promise<void> {
  if (options.index || options.indexRoot) {
    if (options.index && options.indexRoot) {
      throw new ValidationError("Pass --index or --index-root, not both.");
    }
    await issueForIndex(options, options.index ? "member" : "root-move");
    return;
  }
  const config = parseSpaceOptions(options);
  const expiresAt = options.expiresIn === undefined
    ? undefined
    : nowSeconds() + options.expiresIn;
  const pieces = await load(config);
  try {
    // The connection's signer is typed without the key pair a delegation's
    // issuer is, so the identity is loaded for signing on its own.
    const signer = await loadIdentity(config.identity);
    const space = pieces.getSpace();
    if (!isDIDKey(space)) {
      throw new Error(`The space ${space} is not a did:key`);
    }
    const chain = await issueDelegationChain({
      signer,
      space,
      to: options.to as DIDKey,
      held: pieces.runtime.storageManager.delegationChainFor?.(space) ?? [],
      expiresAt,
    });
    const text = encodeDelegationChains([chain]);
    if (options.out === undefined) {
      Deno.stdout.writeSync(new TextEncoder().encode(text));
      return;
    }
    // A chain file is handed to another key, so one is never written over:
    // a caller who wants a new chain under an old name removes the old one.
    await Deno.writeTextFile(options.out, text, { createNew: true });
    const report = {
      out: options.out,
      space,
      to: options.to,
      links: chain.length,
      ...(expiresAt === undefined ? {} : { expires: expiresAt }),
    };
    render(
      options.json
        ? report
        : `Wrote to ${report.out} a chain of ${report.links} over ${report.space} ending at ${report.to}`,
      { json: options.json },
    );
  } finally {
    await pieces.dispose();
  }
}

/**
 * `cf delegation issue --index`: the chain the key `--to` presents to act for
 * the person's pattern-index membership, issued by the index-only root kept
 * on this machine, or behind the identity's own chain where the root lives
 * elsewhere. `--index-root` writes the single-use delegation that moves the
 * membership's root to `--to`.
 */
async function issueForIndex(
  options: IssueOptions,
  kind: IndexDelegationKind,
): Promise<void> {
  // A space set by CF_SPACE is ignored rather than refused: an index
  // delegation is about the membership, and the environment may well name a
  // space for the person's other commands.
  const issued = await issueIndexDelegation({
    kind,
    baseUrl: resolvePatternIndexUrl(options.patternIndexUrl),
    ...(options.identity === undefined
      ? {}
      : { identity: await loadIdentity(options.identity) }),
    to: options.to,
    ...(options.expiresIn === undefined
      ? {}
      : { expiresAt: nowSeconds() + options.expiresIn }),
  });
  const text = encodeDelegationChains([issued.chain]);
  if (options.out === undefined) {
    Deno.stdout.writeSync(new TextEncoder().encode(text));
    return;
  }
  await Deno.writeTextFile(options.out, text, { createNew: true });
  const report = {
    out: options.out,
    command: issued.command,
    root: issued.root,
    to: options.to,
    links: issued.chain.length,
    expires: issued.expires,
  };
  render(
    options.json
      ? report
      : `Wrote to ${report.out} a chain of ${report.links} for ${report.command} from the index root ${report.root} ending at ${report.to}, expiring ${
        expiryText(report.expires)
      }`,
    { json: options.json },
  );
}

/**
 * An expiry as a date, or as the unix second it is where that is beyond
 * what a `Date` represents: a chain file is described whatever it holds.
 */
const expiryText = (expires: number | null): string => {
  if (expires === null) return "never";
  const date = new Date(expires * 1000);
  return Number.isNaN(date.getTime()) ? String(expires) : date.toISOString();
};

/** `cf delegation show`: each delegation of each chain `file` holds. */
async function show(
  options: { json?: boolean },
  file: string,
): Promise<void> {
  const rows = await describeDelegationChains(
    await readDelegationChainFile(file),
  );
  if (options.json) {
    render(rows, { json: true });
    return;
  }
  if (rows.length === 0) {
    render("No chains.");
    return;
  }
  new Table()
    .header([
      "CHAIN",
      "LINK",
      "CID",
      "ISSUER",
      "AUDIENCE",
      "SUBJECT",
      "COMMAND",
      "EXPIRES",
      "VERIFIED",
    ])
    .body(rows.map((row) => [
      String(row.chain),
      String(row.link),
      row.cid,
      row.issuer,
      row.audience,
      row.subject ?? "(any)",
      row.command,
      expiryText(row.expires),
      row.verified === true ? "yes" : row.verified,
    ]))
    .border(true)
    .render();
}

export const delegation = new Command()
  .name("delegation")
  .description(
    "Delegate a space to another key, and read the chains such a key holds.",
  )
  .default("help")
  /* delegation issue */
  .command(
    "issue",
    targetOptions(
      new Command()
        .description(
          "Issue a delegation over the space from your identity to another " +
            "key, and write the chain that key presents to open the space.",
        )
        .option(
          "--to <did:string>",
          "The DID of the key being delegated to.",
          { required: true },
        )
        .option(
          "--expires-in <seconds:integer>",
          "How long the delegation holds, in seconds; forever by default, " +
            "and 90 days (the most the index accepts) with --index.",
        )
        .option(
          "--index",
          "Delegate your pattern-index membership (/index) instead of a " +
            "space, from the index root kept on this machine; no space.",
        )
        .option(
          "--index-root",
          "Delegate the single-use /index/root that moves your membership's " +
            "root to --to, which presents it with cf index move-root.",
        )
        .env(
          "CF_PATTERN_INDEX_URL=<url:string>",
          "Base URL of the pattern index --index delegates for.",
          { prefix: "CF_" },
        )
        .option(
          "--pattern-index-url <url:string>",
          "Base URL of the pattern index --index delegates for; the " +
            "deployment's by default.",
        )
        .option(
          "--out <path:string>",
          "Where to write the chain file, which must not exist; stdout by " +
            "default.",
        )
        .option("--json", "Report the write as JSON.")
        .example(
          cliText(
            "cf delegation issue --to did:key:z6Mk... --out agent.json " +
              "-i ./me.key -a <url> -s did:key:z6Mk...",
          ),
          "Write the chain the agent key presents to open the space.",
        )
        .example(
          cliText(
            "cf delegation issue --index --to did:key:z6Mk... --out loom-index.json -i ./me.key",
          ),
          "Write the chain a Loom instance key presents to publish as you.",
        )
        .action((options) => delegationIssueAction(options)),
      { global: false },
    ),
  )
  /* delegation show */
  .command(
    "show <file:string>",
    "Describe each delegation of each chain a chain file holds.",
  )
  .option("--json", "Print the rows as JSON.")
  .example(
    cliText("cf delegation show agent.json"),
    "Describe the chains agent.json holds.",
  )
  .action(show);
