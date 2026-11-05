import { Command } from "@cliffy/command";
import { Table } from "@cliffy/table";
import { isCapability } from "@commonfabric/memory/acl";

import { getAcl, leaveAcl, removeAclEntry, setAclEntry } from "../lib/acl.ts";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import { parseSpaceOptions } from "./piece.ts";

// Usage patterns for examples
const spaceUsage = `--identity <identity> --api-url <api-url> --space <space>`;

export const acl = new Command()
  .name("acl")
  .description("Manage Access Control Lists for spaces.")
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
  .globalEnv("CF_SPACE=<space:string>", "The space name or DID.", {
    prefix: "CF_",
  })
  .globalOption("-s,--space <space:string>", "The space name or DID")
  /* acl ls */
  .command("ls", "List all ACL entries for a space.")
  .usage(spaceUsage)
  .example(
    cliText(
      "cf acl ls --identity ./my.key --api-url https://api.example.com --space my-space",
    ),
    "List all ACL entries for my-space",
  )
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    const aclData = await getAcl(config);

    if (!aclData || Object.keys(aclData).length === 0) {
      render("No ACL entries found.");
      return;
    }

    new Table()
      .header(["DID", "CAPABILITY"])
      .body(
        Object.entries(aclData).map(([did, capability]) => [did, capability]),
      )
      .border(true)
      .render();
  })
  /* acl set */
  .command(
    "set <did:string> <capability:string>",
    "Applies a capability (READ, WRITE, OWNER) to an identity (DID) to the space ACL.",
  )
  .usage(`${spaceUsage} <did> <capability>`)
  .example(
    cliText(
      "cf acl set did:key:z6Mkk... WRITE --identity ./my.key --api-url https://api.example.com --space my-space",
    ),
    "Grant WRITE capability to a DID",
  )
  .action(async (options, did, capability) => {
    const cap = capability.toUpperCase();
    if (!isCapability(cap)) {
      render(
        `Invalid capability: ${capability}. Must be one of: READ, WRITE, OWNER`,
      );
      Deno.exit(1);
    }

    const config = parseSpaceOptions(options);
    await setAclEntry(
      config,
      did,
      cap as "READ" | "WRITE" | "OWNER",
    );
    render(`Added ${did} with ${cap} capability`);
  })
  /* acl remove */
  .command("remove <did:string>", "Remove a DID from the space ACL.")
  .usage(`${spaceUsage} <did>`)
  .example(
    cliText(
      "cf acl remove did:key:z6Mkk... --identity ./my.key --api-url https://api.example.com --space my-space",
    ),
    "Remove a DID from the ACL",
  )
  .action(async (options, did) => {
    const config = parseSpaceOptions(options);
    await removeAclEntry(config, did);
    render(`Removed ${did} from ACL`);
  })
  /* acl leave */
  .command(
    "leave",
    "Remove your own identity from the space ACL, giving up the access it grants.",
  )
  .usage(spaceUsage)
  .example(
    cliText(
      "cf acl leave --identity ./my.key --api-url https://api.example.com --space shared-space",
    ),
    "Leave shared-space",
  )
  .action(async (options) => {
    const config = parseSpaceOptions(options);
    const outcome = await leaveAcl(config);
    render(
      outcome === "left"
        ? `Left ${config.space}`
        : `Not in the ACL of ${config.space}; nothing to leave`,
    );
  });
