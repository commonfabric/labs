/** Generic invitation commands use the same signed client as browser shells. */
import { Command, ValidationError } from "@cliffy/command";
import { isDIDKey } from "@commonfabric/identity/did";
import {
  buildInviteLink,
  normalizeInviteHost,
  SpaceInviteClient,
} from "@commonfabric/runner/space-invites";
import { loadIdentity } from "../lib/identity.ts";
import { parseSpaceOptions } from "./piece.ts";

/** Builds the `cf space invite` command group. */
export function buildSpaceInviteCommand() {
  const client = async (
    options: { identity?: string; apiUrl?: string; space?: string },
  ) => {
    const config = parseSpaceOptions(options);
    if (!isDIDKey(config.space)) {
      throw new ValidationError("Invitations require an explicit space DID.");
    }
    return {
      config,
      client: new SpaceInviteClient({
        host: config.apiUrl,
        space: config.space,
        signer: await loadIdentity(config.identity),
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
      const shell = options.shell === undefined
        ? undefined
        : normalizeInviteHost(options.shell);
      const { client: api, config } = await client(options);
      const invite = await api.create({
        access: options.access,
        ttlSeconds: options.ttl,
        maxUses: options.maxUses,
      });
      console.log(
        JSON.stringify({
          ...invite,
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
      "redeem <invite-id:string>",
      "Redeem as the identity keyfile's DID.",
    )
    .option(
      "--code-file <path:string>",
      "File containing the bearer code; use - for stdin.",
    )
    .action(async (options, inviteId) => {
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
      "revoke <invite-id:string>",
      "Disable admission without removing existing access.",
    )
    .action(async (options, inviteId) =>
      console.log(
        JSON.stringify(await (await client(options)).client.revoke(inviteId)),
      )
    )
    .command(
      "receipts [invite-id:string]",
      "List distinct invitation and identity receipt pairs.",
    )
    .action(async (options, inviteId) =>
      console.log(
        JSON.stringify(await (await client(options)).client.receipts(inviteId)),
      )
    );
}
