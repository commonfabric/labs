import { Command, EnumType, ValidationError } from "@cliffy/command";
import {
  decodeDelegationChains,
  isCanonicalEd25519DID,
} from "@commonfabric/identity";
import {
  PatternIndexError,
  type PatternIndexSetSharingSettingsRequest,
  type PatternIndexSharingSettings,
} from "@commonfabric/pattern-index/client";

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

/** `on` or `off`, as `cf index sharing` takes them, as a boolean. */
const onOff = (value: string, what: string): boolean => {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new ValidationError(`${what} is on or off, not "${value}".`);
};

/**
 * The change `cf index sharing [on|off] [--self-built on|off]` asks for:
 * only the switches named, or none, which reads the setting.
 *
 * @throws ValidationError for a value other than `on` or `off`.
 */
export const sharingChange = (
  state: string | undefined,
  selfBuilt: string | undefined,
): PatternIndexSetSharingSettingsRequest => ({
  ...(state === undefined ? {} : { enabled: onOff(state, "Sharing") }),
  ...(selfBuilt === undefined
    ? {}
    : { selfBuilt: onOff(selfBuilt, "--self-built") }),
});

/** The setting as lines for a person: what each switch means for them. */
export const sharingLines = (
  settings: PatternIndexSharingSettings,
): string[] => {
  if (!settings.enabled) {
    return [
      "Sharing: off. Nothing of yours is shared anonymously, and search and listings show you only patterns published under a name; a shared pattern you open by its id still works.",
      "Turn it on with cf index sharing on.",
    ];
  }
  return [
    "Sharing: on. Patterns agents make for you are shared anonymously once you open them in your loom and they pass the privacy check, and you see what others share.",
    settings.selfBuilt
      ? "Patterns you build yourself (cf, Claude Code): shared the same way. Turn that off with cf index sharing --self-built off."
      : "Patterns you build yourself (cf, Claude Code): kept private unless you run cf pattern share. Share them by default with cf index sharing --self-built on.",
  ];
};

async function sharing(
  options: IndexOptions & { selfBuilt?: string },
  state: string | undefined,
): Promise<void> {
  const change = sharingChange(state, options.selfBuilt);
  const signer = await loadIdentity(requireIdentityPath(options));
  const client = await openPatternIndexClient({
    baseUrl: resolvePatternIndexUrl(options.patternIndexUrl),
    signer,
  });
  const settings =
    await (Object.keys(change).length === 0
      ? client.getSharingSettings()
      : client.setSharingSettings(change)).catch(rethrowAsNotMember);
  render(options.json ? settings : sharingLines(settings).join("\n"), {
    json: options.json,
  });
}

async function admit(options: IndexOptions, did: string): Promise<void> {
  if (!isCanonicalEd25519DID(did)) {
    throw new ValidationError(`"${did}" is not an ed25519 did:key.`);
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
    "Join the pattern index, where patterns are kept, shared and found.",
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
  )
  /* index sharing */
  .command(
    "sharing",
    indexAccessOptions(
      new Command()
        .description(
          "Show or change your give-to-get setting, the same one your " +
            "loom's settings change. On (the default), your patterns are " +
            "shared anonymously once you open them in your loom and they " +
            "pass the privacy " +
            "check, and you see what others share; off, nothing of yours " +
            "is shared, and search and listings show you only patterns " +
            "published under a name (one opened by its id still works). " +
            "--self-built says whether that covers the patterns you build " +
            "yourself in cf and Claude Code.",
        )
        .type("on-off", new EnumType(["on", "off"]))
        .arguments("[state:on-off]")
        .option(
          "--self-built <state:on-off>",
          "on or off: whether patterns you build yourself are shared too.",
        )
        .example(cliText("cf index sharing"), "Show the setting.")
        .example(
          cliText("cf index sharing on --self-built off"),
          "Share and see others' patterns, keeping what you build private.",
        ),
    ).action(sharing),
  );
