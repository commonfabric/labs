import { Command, ValidationError } from "@cliffy/command";
import { decodeDelegationChains } from "@commonfabric/identity";
import { isDIDKey } from "@commonfabric/identity/did";
import { PatternIndexError } from "@commonfabric/pattern-index/client";

import { cliText } from "../lib/cli-name.ts";
import { loadIdentity } from "../lib/identity.ts";
import {
  openPatternIndexClient,
  resolvePatternIndexUrl,
} from "@commonfabric/pattern-index/access";
import {
  adoptIndexChain,
  joinPatternIndex,
  type JoinResult,
  moveMembershipRoot,
  parseInviteLink,
} from "@commonfabric/pattern-index/join";
import { render } from "../lib/render.ts";

/** What every `cf index` subcommand takes. */
interface IndexOptions {
  identity?: string;
  patternIndexUrl?: string;
  json?: boolean;
}

/** The identity keyfile, or a usage error saying how to name one. */
export const requireIdentityPath = (options: { identity?: string }): string => {
  if (options.identity === undefined || options.identity === "") {
    throw new ValidationError(
      "Name the identity cf signs with: pass --identity <keyfile>, or set CF_IDENTITY.",
    );
  }
  return options.identity;
};

/**
 * Rethrows an index refusal of the identity (401 or 403) as what to do about
 * it; anything else as it is.
 */
export const rethrowAsNotMember = (error: unknown): never => {
  if (
    error instanceof PatternIndexError &&
    (error.status === 401 || error.status === 403)
  ) {
    throw new Error(
      "The pattern index does not know this identity as a member: join with your invite link (pipe it to cf index join), or adopt a chain from the machine that joined with cf index join --chain <file>.",
    );
  }
  throw error;
};

/** Reads the invite link from stdin, so it never reaches shell history. */
const readLinkFromStdin = async (): Promise<string> => {
  const text = await new Response(Deno.stdin.readable).text();
  if (text.trim() === "") {
    throw new ValidationError(
      "Pass the invite link, or pipe it on stdin (so it stays out of shell history).",
    );
  }
  return text;
};

/** What a join prints: who the person is now, and what to do with the root. */
export const joinReport = (result: JoinResult): string =>
  [
    result.joined
      ? `Joined the pattern index as ${result.handle}.`
      : `Already a member of the pattern index as ${result.handle}.`,
    result.rootKeptHere
      ? `Back up ${result.storeDir}: it holds the key your membership is rooted at, and with it your standing on the index.`
      : `This machine holds a chain from your membership's root, not the root itself; back up the root where it is kept.`,
    `Next: ${cliText("cf pattern publish <entry file>")}`,
  ].join("\n");

async function join(
  options: IndexOptions & { chain?: string },
  link?: string,
): Promise<void> {
  const signer = await loadIdentity(requireIdentityPath(options));
  const baseUrl = resolvePatternIndexUrl(options.patternIndexUrl);
  let result: JoinResult;
  if (options.chain !== undefined) {
    if (link !== undefined) {
      throw new ValidationError(
        "Join with an invite link or with --chain, not both.",
      );
    }
    const chains = decodeDelegationChains(
      await Deno.readTextFile(options.chain),
    );
    if (chains.length !== 1) {
      throw new ValidationError(
        `${options.chain} holds ${chains.length} chains; an index chain file holds one.`,
      );
    }
    result = await adoptIndexChain({ baseUrl, signer, chain: chains[0] });
  } else {
    const invite = parseInviteLink(link ?? await readLinkFromStdin());
    result = await joinPatternIndex({ baseUrl, signer, invite });
  }
  render(options.json ? result : joinReport(result), { json: options.json });
}

async function whoami(options: IndexOptions): Promise<void> {
  const signer = await loadIdentity(requireIdentityPath(options));
  const client = await openPatternIndexClient({
    baseUrl: resolvePatternIndexUrl(options.patternIndexUrl),
    signer,
  });
  const member = await client.whoami().catch(rethrowAsNotMember);
  render(
    options.json
      ? { ...member, signer: signer.did() }
      : `${member.handle} (${member.role}), signing as ${signer.did()}`,
    { json: options.json },
  );
}

async function admit(options: IndexOptions, did: string): Promise<void> {
  if (!isDIDKey(did)) {
    throw new ValidationError(`"${did}" is not a did:key.`);
  }
  const signer = await loadIdentity(requireIdentityPath(options));
  const client = await openPatternIndexClient({
    baseUrl: resolvePatternIndexUrl(options.patternIndexUrl),
    signer,
  });
  const member = await client.admitKey({ did });
  render(
    options.json
      ? { ...member, did }
      : `Admitted ${did} as ${member.handle} (${member.role}).`,
    { json: options.json },
  );
}

async function moveRoot(options: IndexOptions, file: string): Promise<void> {
  const chains = decodeDelegationChains(await Deno.readTextFile(file));
  if (chains.length !== 1 || chains[0].length !== 1) {
    throw new ValidationError(
      `${file} does not hold one root-move delegation; cf delegation issue --index-root writes one.`,
    );
  }
  const signer = await loadIdentity(requireIdentityPath(options));
  const result = await moveMembershipRoot({
    baseUrl: resolvePatternIndexUrl(options.patternIndexUrl),
    signer,
    rootDelegation: chains[0][0],
  });
  render(
    options.json
      ? result
      : `${result.handle} is now rooted at ${result.root}. Chains issued from the old root no longer work; issue new ones with cf delegation issue --index.`,
    { json: options.json },
  );
}

/** The options every subcommand shares. */
// deno-lint-ignore no-explicit-any
export const indexAccessOptions = (cmd: Command<any>) =>
  cmd
    .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
      prefix: "CF_",
    })
    .option("-i,--identity <path:string>", "Path to an identity keyfile.")
    .env(
      "CF_PATTERN_INDEX_URL=<url:string>",
      "Base URL of the pattern index.",
      { prefix: "CF_" },
    )
    .option(
      "--pattern-index-url <url:string>",
      "Base URL of the pattern index; the deployment's by default.",
    )
    .option("--json", "Print the result as JSON.");

export const index = new Command()
  .name("index")
  .description(
    "Join the pattern index, where patterns are published and found.",
  )
  .default("help")
  /* index join */
  .command(
    "join",
    indexAccessOptions(
      new Command()
        .description(
          "Join the pattern index with an invite link. Makes a key for the " +
            "index alone as your membership's root, redeems the invite with " +
            "it, and lets your cf identity act for you. With --chain, joins " +
            "this machine to a membership rooted on another one instead.",
        )
        .arguments("[link:string]")
        .option(
          "--chain <path:string>",
          "A chain file your root issued to this identity " +
            "(cf delegation issue --index on the machine holding the root).",
        )
        .example(
          cliText("pbpaste | cf index join -i ~/.cf/me.key"),
          "Join with the invite link on the clipboard, keeping it out of shell history.",
        )
        .example(
          cliText("cf index join --chain laptop-index.json -i ./laptop.key"),
          "Join this machine to a membership rooted elsewhere.",
        )
        .action(join),
    ),
  )
  /* index admit */
  .command(
    "admit",
    indexAccessOptions(
      new Command()
        .description(
          "Admit a key as a new member, without an invite. Admins only; an " +
            "invite is the usual way in.",
        )
        .arguments("<did:string>"),
    ).action(admit),
  )
  /* index move-root */
  .command(
    "move-root",
    indexAccessOptions(
      new Command()
        .description(
          "Make your identity your membership's root, presenting the " +
            "single-use delegation the current root issued with " +
            "cf delegation issue --index-root --to <this identity's DID>.",
        )
        .arguments("<file:string>"),
    ).action(moveRoot),
  )
  /* index whoami */
  .command(
    "whoami",
    indexAccessOptions(
      new Command()
        .description("Who the pattern index sees your cf identity as."),
    ).action(whoami),
  );
