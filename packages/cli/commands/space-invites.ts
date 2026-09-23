/** Generic invitation commands use the same signed client as browser shells. */
import { dirname, resolve } from "@std/path";
import { Command, ValidationError } from "@cliffy/command";
import { isDIDKey } from "@commonfabric/identity/did";
import {
  buildInviteLink,
  createInviteCredentials,
  type InviteAccess,
  inviteCodeVerifier,
  normalizeInviteHost,
  SPACE_INVITE_CAPABILITY,
  SpaceInviteClient,
} from "@commonfabric/runner/space-invites";
import { loadIdentity } from "../lib/identity.ts";
import { parseSpaceOptions } from "./piece.ts";

interface InviteRequestBinding {
  host: string;
  space: string;
  issuer: string;
  access: InviteAccess;
  ttlSeconds: number;
  maxUses: number;
}

interface PreparedInviteRequest extends InviteRequestBinding {
  version: 1;
  inviteId: string;
  code: string;
}

async function prepareInviteRequest(
  binding: InviteRequestBinding,
  requestedPath?: string,
): Promise<{ request: PreparedInviteRequest; requestFile: string }> {
  const request: PreparedInviteRequest = {
    version: 1,
    ...binding,
    ...createInviteCredentials(),
  };
  inviteCodeVerifier(request);
  let requestFile: string;
  if (requestedPath !== undefined) {
    requestFile = resolve(requestedPath);
    const parent = await Deno.lstat(dirname(requestFile));
    if (
      !parent.isDirectory || parent.isSymlink ||
      (parent.mode !== null && (parent.mode & 0o077) !== 0)
    ) {
      throw new ValidationError(
        "Invitation request parent must be a private directory (0700).",
      );
    }
  } else {
    const state = Deno.env.get("XDG_STATE_HOME");
    const home = Deno.env.get("HOME");
    if (!state && !home) {
      throw new ValidationError(
        "Specify --request-file when no user state directory is configured.",
      );
    }
    const directory = state
      ? resolve(state, "commonfabric", "space-invites")
      : resolve(home!, ".local", "state", "commonfabric", "space-invites");
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(directory);
    if (
      !info.isDirectory || info.isSymlink ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) {
      throw new ValidationError(
        "Invitation request directory must be a private directory (0700).",
      );
    }
    requestFile = resolve(directory, `${request.inviteId}.json`);
  }
  let file: Deno.FsFile;
  try {
    file = await Deno.open(requestFile, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
  } catch (error) {
    if (
      !(error instanceof Deno.errors.AlreadyExists) ||
      requestedPath === undefined
    ) throw error;
    const info = await Deno.lstat(requestFile);
    if (
      !info.isFile || info.isSymlink ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) {
      throw new ValidationError(
        "Invitation request file must be a private regular file (0600).",
      );
    }
    using retainedFile = await Deno.open(requestFile, { read: true });
    const opened = await retainedFile.stat();
    if (
      !opened.isFile || info.ino === null ||
      opened.dev !== info.dev || opened.ino !== info.ino ||
      (opened.mode !== null && (opened.mode & 0o077) !== 0)
    ) {
      throw new ValidationError(
        "Invitation request file changed while opening.",
      );
    }
    let stored: unknown;
    try {
      stored = JSON.parse(await new Response(retainedFile.readable).text());
    } catch {
      throw new ValidationError("Invalid invitation request file.");
    }
    if (
      stored === null || typeof stored !== "object" || !("version" in stored) ||
      stored.version !== 1 ||
      !("inviteId" in stored) || typeof stored.inviteId !== "string" ||
      !("code" in stored) || typeof stored.code !== "string"
    ) {
      throw new ValidationError("Invalid invitation request file.");
    }
    for (const [key, value] of Object.entries(binding)) {
      if (Reflect.get(stored, key) !== value) {
        throw new ValidationError(
          "Invitation request file does not match the host, space, signing identity, or creation options.",
        );
      }
    }
    const retained: PreparedInviteRequest = {
      version: 1,
      ...binding,
      inviteId: stored.inviteId,
      code: stored.code,
    };
    try {
      inviteCodeVerifier(retained);
    } catch {
      throw new ValidationError("Invalid invitation request file.");
    }
    return { request: retained, requestFile };
  }
  using ownedFile = file;
  const bytes = new TextEncoder().encode(JSON.stringify(request) + "\n");
  let written = 0;
  while (written < bytes.length) {
    written += await ownedFile.write(bytes.subarray(written));
  }
  await ownedFile.sync();
  return { request, requestFile };
}

/** Usage line for a command that requires an invitation ID. */
const requiredInviteIdUsage = "<invite-id> | [options] -- <invite-id>";

/**
 * Returns the invitation ID a command names, written either as its argument or
 * as the one word after `--`, or `undefined` when it names none. Throws a
 * `ValidationError` when it names one in both places, or when more than one
 * word follows `--`.
 *
 * An invitation ID may begin with "-". The parser reads such a word in the
 * argument's place as an option, and sets every word after `--` aside unparsed,
 * so an ID beginning with "-" is written after `--`.
 */
function optionalInviteId(
  argument: string | undefined,
  literal: readonly string[],
): string | undefined {
  if (literal.length === 0) return argument;
  if (literal.length > 1) {
    throw new ValidationError(
      "Only the invitation ID may follow `--`; options go before it.",
    );
  }
  if (argument !== undefined) {
    throw new ValidationError(
      "Name the invitation ID either before or after `--`, not both.",
    );
  }
  return literal[0];
}

/**
 * Like {@link optionalInviteId}, except that naming no invitation ID throws a
 * `ValidationError`.
 */
function requiredInviteId(
  argument: string | undefined,
  literal: readonly string[],
): string {
  const inviteId = optionalInviteId(argument, literal);
  if (inviteId === undefined) {
    throw new ValidationError("Missing argument: `invite-id`.");
  }
  return inviteId;
}

/** Builds the `cf space invite` command group. */
export function buildSpaceInviteCommand() {
  const client = async (
    options: { identity?: string; apiUrl?: string; space?: string },
  ) => {
    const config = parseSpaceOptions(options);
    if (!isDIDKey(config.space)) {
      throw new ValidationError("Invitations require an explicit space DID.");
    }
    const signer = await loadIdentity(config.identity);
    return {
      config,
      issuer: signer.did(),
      client: new SpaceInviteClient({
        host: config.apiUrl,
        space: config.space,
        signer,
      }),
    };
  };
  return new Command()
    .name("invite").description(
      "Create, redeem, and revoke generic space invitations.",
    ).default("help")
    .globalEnv("CF_API_URL=<url:string>", "URL of the fabric service.", {
      prefix: "CF_",
    })
    .globalOption("-a,--api-url <url:string>", "URL of the fabric service.")
    .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
      prefix: "CF_",
    })
    .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
    .globalEnv("CF_SPACE=<space:string>", "Target space DID.", {
      prefix: "CF_",
    })
    .globalOption("-s,--space <space:string>", "Target space DID.")
    .command("create", "Create an invitation; output contains the bearer code.")
    .option("--access <access:string>", "READ or WRITE access.")
    .option(
      "--ttl <seconds:integer>",
      "Admission lifetime in seconds, at most 2592000.",
    )
    .option(
      "--max-uses <count:integer>",
      "Distinct identities admitted, at most 1000.",
      { default: 1 },
    )
    .option(
      "--request-file <path:string>",
      "Persist or reuse a private creation request for exact retries.",
    )
    .option(
      "--shell <origin:string>",
      "Shell origin for a fragment-secret join link.",
    )
    .action(async (options) => {
      if (options.access !== "READ" && options.access !== "WRITE") {
        throw new ValidationError("--access must be READ or WRITE.");
      }
      if (options.ttl === undefined) {
        throw new ValidationError("--ttl is required.");
      }
      if (
        options.ttl < 1 || options.ttl > SPACE_INVITE_CAPABILITY.maxTtlSeconds
      ) {
        throw new ValidationError("--ttl must be between 1 and 2592000.");
      }
      if (
        options.maxUses < 1 || options.maxUses > SPACE_INVITE_CAPABILITY.maxUses
      ) {
        throw new ValidationError("--max-uses must be between 1 and 1000.");
      }
      const shell = options.shell === undefined
        ? undefined
        : normalizeInviteHost(options.shell);
      const { client: api, config, issuer } = await client(options);
      const { request, requestFile } = await prepareInviteRequest({
        host: normalizeInviteHost(config.apiUrl),
        space: config.space,
        issuer,
        access: options.access,
        ttlSeconds: options.ttl,
        maxUses: options.maxUses,
      }, options.requestFile);
      console.error(
        `Invite request saved: ${requestFile} (reuse with --request-file)`,
      );
      const invite = await api.create(request);
      console.log(
        JSON.stringify({
          ...invite,
          requestFile,
          ...(shell
            ? {
              link: buildInviteLink(shell, {
                host: config.apiUrl,
                space: config.space,
                inviteId: invite.inviteId,
                code: invite.code,
              }),
            }
            : {}),
        }),
      );
    })
    .command(
      "redeem [invite-id:string]",
      "Redeem as the identity keyfile's DID.",
    )
    .usage(requiredInviteIdUsage)
    .option(
      "--code-file <path:string>",
      "File containing the bearer code; use - for stdin.",
    )
    .action(async function (options, argument) {
      const inviteId = requiredInviteId(argument, this.getLiteralArgs());
      if (!options.codeFile) {
        throw new ValidationError("--code-file is required.");
      }
      const code = (options.codeFile === "-"
        ? await new Response(Deno.stdin.readable).text()
        : await Deno.readTextFile(options.codeFile)).trim();
      console.log(
        JSON.stringify(
          await (await client(options)).client.redeem({ inviteId, code }),
        ),
      );
    })
    .command("list", "List active invitations without their verifiers.")
    .action(async (options) =>
      console.log(JSON.stringify(await (await client(options)).client.list()))
    )
    .command(
      "revoke [invite-id:string]",
      "Disable admission without removing existing access.",
    )
    .usage(requiredInviteIdUsage)
    .action(async function (options, argument) {
      const inviteId = requiredInviteId(argument, this.getLiteralArgs());
      console.log(
        JSON.stringify(await (await client(options)).client.revoke(inviteId)),
      );
    })
    .command(
      "receipts [invite-id:string]",
      "List distinct invitation and identity receipt pairs.",
    )
    .usage("[invite-id] | [options] -- <invite-id>")
    .action(async function (options, argument) {
      const inviteId = optionalInviteId(argument, this.getLiteralArgs());
      console.log(
        JSON.stringify(await (await client(options)).client.receipts(inviteId)),
      );
    });
}
