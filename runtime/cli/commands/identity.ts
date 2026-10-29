import { Command } from "@cliffy/command";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import {
  getDidFromFile,
  pkcs8FromEntropy,
  pkcs8FromMnemonic,
  pkcs8FromPassphrase,
} from "../lib/identity.ts";

export const identity = new Command()
  .name("id")
  .description("Interact with common identites.")
  .default("help")
  /* id new */
  .command("new", "Output a new identity keyfile to stdout.")
  .example(
    cliText("cf id create > ./my.key"),
    "Create and store a keyfile at ./my.key",
  )
  .action(createIdentity)
  /* id did */
  .command("did <keypath:string>", "Output the DID of a keyfile to stdout.")
  .example(
    cliText("cf id did ./my.key"),
    "Outputs the DID of ./my.key to stdout.",
  )
  .action(getDid)
  /* id derive */
  .command(
    "derive",
    "Derive a keyfile from a passphrase. Prefer `-- <file>` or `-` (stdin) " +
      "over an inline argument to keep the secret out of shell history.",
  )
  .example(
    cliText("cf id derive -- passphrase.txt > ./my.key"),
    "Read the passphrase from the file passphrase.txt (recommended; keeps it " +
      "out of shell history and the process list) and store a keyfile at " +
      "./my.key.",
  )
  .example(
    cliText("cf id derive - > ./my.key"),
    "Read the passphrase from stdin (pipe it in, or type it and press Ctrl-D).",
  )
  .example(
    cliText('cf id derive "example passphrase" > ./my.key'),
    'Create a keyfile derived from the inline string "example passphrase". ' +
      "Note: an " +
      "argument passed this way is visible in shell history and to other " +
      "processes via `ps`; prefer a file or stdin for secrets.",
  )
  .arguments("[passphrase:string]")
  .action(async function (_: void, passphrase?: string) {
    const pkcs8Material = await pkcs8FromPassphrase(
      await resolveSecret(passphrase, this.getLiteralArgs(), "passphrase"),
    );
    render(pkcs8Material);
  })
  /* id from-mnemonic */
  .command(
    "from-mnemonic",
    "Derive a keyfile from a BIP-39 mnemonic phrase, matching browser " +
      "mnemonic login. Prefer `-- <file>` or `-` (stdin) over an inline " +
      "argument to keep the phrase out of shell history.",
  )
  .example(
    cliText("cf id from-mnemonic -- phrase.txt > ./my.key"),
    "Read the recovery phrase from the file phrase.txt (recommended; keeps it " +
      "out of shell history and the process list) and create a keyfile whose " +
      "DID matches the browser identity registered with that phrase.",
  )
  .example(
    cliText("cf id from-mnemonic - > ./my.key"),
    "Read the recovery phrase from stdin (pipe it in, or type it and press " +
      "Ctrl-D).",
  )
  .example(
    cliText('cf id from-mnemonic "word1 word2 ... word24" > ./my.key'),
    "Pass the phrase as a single quoted inline argument. Note: this leaks the " +
      "phrase into shell history and the process list; prefer a file or stdin.",
  )
  .arguments("[mnemonic:string]")
  .action(async function (_: void, mnemonic?: string) {
    const pkcs8Material = await pkcs8FromMnemonic(
      await resolveSecret(mnemonic, this.getLiteralArgs(), "mnemonic"),
    );
    render(pkcs8Material);
  });

async function createIdentity() {
  const pkcs8Material = await pkcs8FromEntropy();
  render(pkcs8Material);
}

async function getDid(_: void, keypath: string) {
  const did = await getDidFromFile(keypath);
  render(did);
}

// Resolves a secret (passphrase or mnemonic) from, in order of precedence:
//   * a `-- <file>` argument: read the secret from that file;
//   * a `-` argument, or no argument at all: read the secret from stdin;
//   * otherwise: the inline argument value (used verbatim, for backwards
//     compatibility).
// Reading from a file or stdin keeps the secret out of shell history and the
// process argument list (which is visible to other local processes via `ps`).
// File and stdin input have a single trailing newline stripped so that an
// editor- or `echo`-produced value matches the equivalent inline argument.
async function resolveSecret(
  arg: string | undefined,
  literalArgs: string[],
  label: string,
): Promise<string> {
  if (literalArgs.length > 0) {
    if (arg !== undefined) {
      throw new Error(
        `Provide the ${label} inline or as a -- <file>, not both.`,
      );
    }
    if (literalArgs.length > 1) {
      throw new Error(`Expected a single ${label} file after \`--\`.`);
    }
    const path = literalArgs[0];
    return requireNonEmpty(
      stripTrailingNewline(await Deno.readTextFile(path)),
      label,
      path,
    );
  }
  if (arg !== undefined && arg !== "-") return arg;
  if (Deno.stdin.isTerminal()) {
    console.error(`Reading ${label} from stdin; type it and press Ctrl-D...`);
  }
  return requireNonEmpty(
    stripTrailingNewline(await new Response(Deno.stdin.readable).text()),
    label,
    "stdin",
  );
}

function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

function requireNonEmpty(value: string, label: string, source: string): string {
  if (value.length === 0) {
    throw new Error(`No ${label} provided from ${source}.`);
  }
  return value;
}
