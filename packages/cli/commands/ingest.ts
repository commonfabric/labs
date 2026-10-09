import { Command, ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import {
  type ChannelConfig,
  type GmailProof,
  INGEST_SINKS,
  type IngestSink,
  listChannels,
  mintChannel,
  type MintedChannel,
  newRequestId,
  resolveSpaceDid,
  revokeChannel,
  rotateChannel,
} from "../lib/ingest-channels.ts";

// `cf ingest` — self-serve ingest channels.
//
// This replaces `deno task provision-ingest-channel`, which had to be run by an
// operator on the deployed host with the toolshed's private identity. Here the
// caller signs with their OWN key and the server checks that they hold an
// explicit OWNER grant on the target space, so onboarding a device stops being
// an admin ticket.

const commonUsage = `--identity <identity> --api-url <api-url>`;

// Missing options raise ValidationError — usage text plus the failing option on
// stderr, exit 1 — matching every other command. `cf acl` carried a private
// parser that re-read CF_* from the environment and printed a sentence to
// stdout; labs#5337 removed it as drift, so don't reintroduce it here.
//
// It deliberately does NOT use `parseSpaceOptions`/`loadManager` from
// commands/piece.ts, which every fabric-touching command uses: those build a
// remote-client Runtime with a storage manager and a health check. This command
// only signs an HTTP request, so a Runtime would be pure cost — and `--space`
// is required for `mint` but not for `ls`/`rotate`/`revoke`, which that parser
// cannot express. The environment declarations on the command already map
// CF_API_URL and CF_IDENTITY onto the options read below.
function parseConfig(
  options: { apiUrl?: string; identity?: string },
): ChannelConfig {
  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  return { apiUrl: new URL(options.apiUrl), identityPath: options.identity };
}

const requireSpace = (space: string | undefined): string => {
  if (!space) {
    throw new ValidationError(`Missing required option: "--space".`, {
      exitCode: 1,
    });
  }
  return space;
};

// One proof or none; two is a mistake the server would also refuse.
const gmailProof = (
  accessToken: string | undefined,
  idToken: string | undefined,
): GmailProof | undefined => {
  if (accessToken !== undefined && idToken !== undefined) {
    throw new ValidationError(
      "Give one of --gmail-access-token and --gmail-id-token, not both.",
      { exitCode: 1 },
    );
  }
  if (accessToken !== undefined) return { accessToken };
  if (idToken !== undefined) return { idToken };
  return undefined;
};

// `undefined` is left to the server, which mints a journal.
const requireSink = (sink: string | undefined): IngestSink | undefined => {
  if (sink === undefined) return undefined;
  const known = INGEST_SINKS.find((candidate) => candidate === sink);
  if (known === undefined) {
    throw new ValidationError(
      `Unknown sink "${sink}"; expected one of ${INGEST_SINKS.join(", ")}.`,
      { exitCode: 1 },
    );
  }
  return known;
};

/**
 * Helper for the verbs that act on one channel, which returns the space
 * channel `id` writes into: `named` when the caller passed `--space`, and
 * otherwise the space of that channel in the caller's own list. A request is
 * addressed to the channel's space, so it has to be known before it is sent.
 */
async function channelSpace(
  config: ChannelConfig,
  id: string,
  named: string | undefined,
): Promise<string> {
  const space = named
    ? await resolveSpaceDid(config.identityPath, named)
    : (await listChannels(config)).find((c) => c.id === id)?.space;
  if (space === undefined) {
    throw new Error(
      `No ingest channel ${id} among the ones you minted. Pass --space to ` +
        `name the space it writes into.`,
    );
  }
  return space;
}

/**
 * The token is returned once and never again — say so where it is printed. A
 * `latest` channel comes with no URL and no token, since nothing POSTs to it;
 * what it is for is binding.
 */
const renderMinted = (minted: MintedChannel, verb: string): void => {
  render(`\nIngest channel ${verb}.\n`);
  render(`  id:          ${minted.id}`);
  render(`  space:       ${minted.space}`);
  render(`  causePrefix: ${minted.causePrefix}`);
  render(`  installId:   ${minted.installId}`);
  if (minted.url !== undefined) render(`  URL:         ${minted.url}`);
  render(`  expires:     ${minted.expiresAt ?? "(none — unexpected)"}`);
  if (minted.emailAddress !== undefined) {
    render(`  mailbox:     ${minted.emailAddress}`);
  }
  if (minted.token !== undefined) {
    render(
      `\n  token (shown once — hand it to the device, sent as ` +
        `'Authorization: Bearer <token>'):\n\n    ${minted.token}\n`,
    );
  } else if (minted.emailAddress !== undefined) {
    render(
      `\n  Each Gmail push notification for that mailbox now replaces the ` +
        `record in the channel's cell, once a \`users.watch\` on the ` +
        `mailbox names this deployment's topic.\n`,
    );
  } else {
    render(
      `\n  A \`latest\` channel: no device URL and no token. Mint it again ` +
        `with --gmail-access-token or --gmail-id-token to bind a mailbox.\n`,
    );
  }
};

export const ingest = new Command()
  .name("ingest")
  .description(
    "Mint and manage ingest channels — bearer-token endpoints that let a " +
      "device with no identity of its own durably append records to your space.",
  )
  .default("help")
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric server instance.", {
    prefix: "CF_",
  })
  .globalOption(
    "-a,--api-url <url:string>",
    "URL of the fabric server instance.",
  )
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  /* ingest mint */
  .command(
    "mint",
    "Mint a channel for a space you own. A journal's token is printed ONCE; " +
      "a latest channel has none.",
  )
  .usage(`${commonUsage} --space <space> --install-id <id>`)
  .option(
    "-s,--space <space:string>",
    "The space DID to write into (a name also works, but see the docs: " +
      "named-space keys derive from a public passphrase).",
  )
  .option(
    "--install-id <id:string>",
    "Stable per-device id. Also the cross-repo join key and the mark's audience.",
  )
  .option(
    "--cause-prefix <prefix:string>",
    "Cell-cause prefix; partition cells are <prefix>/<partition>.",
  )
  .option("--name <name:string>", "Human-readable label.")
  .option(
    "--ttl-days <days:number>",
    "Days until the token expires (default 90). Every channel expires; this " +
      "only chooses when.",
  )
  .option(
    "--sink <kind:string>",
    "What the channel's writes land in: `journal`, records in per-day " +
      "partition cells that a device POSTs to (the default), or `latest`, one " +
      "cell holding the newest Gmail push notification. A mailbox proof " +
      "makes it `latest`.",
  )
  // The tokens are credentials, so the environment is the better carrier: an
  // option value is visible in the process list and lands in shell history.
  .env(
    "CF_GMAIL_ACCESS_TOKEN=<token:string>",
    "A Google access token that reads the mailbox to bind.",
    { prefix: "CF_" },
  )
  .env(
    "CF_GMAIL_ID_TOKEN=<token:string>",
    "A Google ID token naming the mailbox to bind.",
    { prefix: "CF_" },
  )
  .option(
    "--gmail-access-token <token:string>",
    "Binds the channel to the Gmail mailbox this access token reads. The " +
      "server uses it for one profile lookup and does not keep it.",
  )
  .option(
    "--gmail-id-token <token:string>",
    "Binds the channel to the Gmail mailbox this Google ID token names. It " +
      "grants nothing, so prefer it where a consent returned one.",
  )
  .example(
    cliText("cf ingest mint --space did:key:z6Mk... --install-id phone-1"),
    "Mint a channel for a space you own",
  )
  .example(
    cliText(
      "CF_GMAIL_ACCESS_TOKEN=... cf ingest mint --space did:key:z6Mk... --install-id gmail-1",
    ),
    "Mint a channel bound to the mailbox the token reads",
  )
  .action(async (options) => {
    const config = parseConfig(options);
    const space = await resolveSpaceDid(
      config.identityPath,
      requireSpace(options.space),
    );
    if (!options.installId) {
      throw new ValidationError(`Missing required option: "--install-id".`, {
        exitCode: 1,
      });
    }
    const minted = await mintChannel(config, {
      space,
      installId: options.installId,
      causePrefix: options.causePrefix,
      name: options.name,
      ttlDays: options.ttlDays,
      sink: requireSink(options.sink),
      gmail: gmailProof(options.gmailAccessToken, options.gmailIdToken),
      requestId: newRequestId(),
    });
    renderMinted(minted, "minted");
  })
  /* ingest ls */
  .command("ls", "List ingest channels.")
  .usage(commonUsage)
  .option(
    "-s,--space <space:string>",
    "List EVERY channel targeting this space, whoever minted it. Requires " +
      "that you currently own the space, and is how you find channels minted " +
      "by someone whose access has since been removed. Without it you see " +
      "only channels you minted yourself.",
  )
  .action(async (options) => {
    const config = parseConfig(options);
    const space = options.space
      ? await resolveSpaceDid(config.identityPath, options.space)
      : undefined;
    const channels = await listChannels(config, { space });

    if (channels.length === 0) {
      render("No ingest channels found.");
      return;
    }
    new Table()
      .header(["ID", "INSTALL", "SPACE", "STATE", "LAST SEEN"])
      .body(
        channels.map((c) => [
          c.id,
          c.installId,
          c.space,
          c.revoked ? "revoked" : c.enabled ? "active" : "disabled",
          c.lastSeenAt ?? "never",
        ]),
      )
      .border(true)
      .render();
  })
  /* ingest rotate */
  .command("rotate <id:string>", "Mint a new token for a channel you own.")
  .usage(`${commonUsage} <id>`)
  .option(
    "--ttl-days <days:number>",
    "Days until the new token expires. Omit to keep the current window.",
  )
  // No `-s` short form, for the reason `revoke --space` has none.
  .option(
    "--space <space:string>",
    "The space the channel writes into. Without it the space is looked up " +
      "among the channels you minted.",
  )
  .action(async (options, id: string) => {
    const config = parseConfig(options);
    const space = await channelSpace(config, id, options.space);
    const minted = await rotateChannel(config, {
      space,
      id,
      ttlDays: options.ttlDays,
      requestId: newRequestId(),
    });
    // A `latest` channel has no device token, so there is no device to tell.
    if (minted.token !== undefined) {
      render(
        "\nThe previous token stopped working. A device still holding it " +
          "gets 403 'Channel rotated — re-pair this device' rather than a " +
          "blank 401, so it can tell this apart from an outage.",
      );
    }
    renderMinted(minted, "rotated");
  })
  /* ingest revoke */
  .command("revoke <id:string>", "Disable a channel you own.")
  .usage(`${commonUsage} <id>`)
  // No `-s` short form, unlike `ls --space`: cliffy's generic inference does
  // not unify a short-flag option with this command's positional argument, and
  // the whole builder chain stops type-checking.
  .option(
    "--space <space:string>",
    "Look the channel up among EVERY channel targeting this space rather " +
      "than only the ones you minted. Required to revoke a channel minted by " +
      "someone whose access to the space has since been removed — that is the " +
      "case revocation by the current owner exists for, and such a channel is " +
      "not in your own list.",
  )
  .action(async (options, id: string) => {
    const config = parseConfig(options);
    // Read before write, deliberately. `revoke` binds to the generation the
    // caller looked at, which is what stops a captured-and-withheld revoke from
    // landing on a credential minted after it was signed. If the channel moved
    // in between, the server refuses and says so — the correct outcome, since
    // the thing being revoked would not be the thing that was seen.
    const space = options.space
      ? await resolveSpaceDid(config.identityPath, options.space)
      : undefined;
    const found = (await listChannels(config, { space })).find((c) =>
      c.id === id
    );
    if (!found) {
      throw new Error(
        space
          ? `No ingest channel ${id} targeting that space.`
          : `No ingest channel ${id} among the ones you minted. A revoked ` +
            `channel is not in your own list — pass --space to look it up ` +
            `there, which is also how to reach one minted by someone whose ` +
            `access to the space has since been removed.`,
      );
    }
    if (found.revoked) {
      render(
        `${id} was already revoked at ${found.revoked.at}. Re-issuing the ` +
          `revoke to confirm; the original attribution is kept.`,
      );
    }
    const { revokedAt } = await revokeChannel(config, {
      space: found.space,
      id,
      requestId: newRequestId(),
      expectedRevision: found.revision,
    });
    // The registration is kept deliberately — it is the only record of who was
    // authorized to write provenance-marked data into the space.
    render(
      `Revoked ${id} at ${revokedAt}. Further POSTs are refused; the ` +
        `registration is retained as an audit record.`,
    );
  })
  // Returns the chain to the top-level `ingest` command. Without it the export
  // is typed as whatever the LAST subcommand's builder produced, and once that
  // subcommand carries an option the type no longer unifies where main.ts
  // mounts it.
  .reset();
