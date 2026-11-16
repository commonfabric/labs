import { Command, ValidationError } from "@cliffy/command";
import { decodeDelegationChains } from "@commonfabric/identity";

import { cliText } from "../lib/cli-name.ts";
import { loadIdentity } from "../lib/identity.ts";
import {
  adoptIndexChain,
  joinPatternIndex,
  type JoinResult,
  openPatternIndexClient,
  parseInviteLink,
  resolvePatternIndexUrl,
} from "../lib/pattern-index-access.ts";
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
      : `Already a member of the pattern index as ${result.handle}; ${result.signer} acts for you.`,
    `Your membership is rooted at a key made for the index alone, kept in ${result.storeDir}. Back that directory up: it is your standing on the index.`,
    `cf signs as ${result.signer} and presents a chain from that root, renewed automatically.`,
    `To publish from Loom too, give its instance key a chain: ${
      cliText(
        "cf delegation issue --index --to <loom instance DID> --out loom-index.json",
      )
    }`,
    `Next: ${cliText("cf pattern publish ./pattern.tsx")}`,
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
  const member = await client.whoami();
  render(
    options.json
      ? { ...member, signer: signer.did() }
      : `${member.handle} (${member.role}), signing as ${signer.did()}`,
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
  /* index whoami */
  .command(
    "whoami",
    indexAccessOptions(
      new Command()
        .description("Who the pattern index sees your cf identity as."),
    ).action(whoami),
  );
