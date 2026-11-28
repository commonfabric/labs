/**
 * `cf fetch`: one request to a first-party Common Fabric service, signed as
 * the identity (`CF1`, `@commonfabric/runner/toolshed-http-auth`).
 *
 * Why: a service that admits its owner by a signed request (a Common Fabric
 * Service on a cloud host does, on every route) is otherwise reachable only
 * from a client that signs, such as the Weaver. A person making patterns from
 * Claude Code needs two things from it, where their panes mount pieces from
 * and a place on their Making loom for a new one, and nothing else on their
 * Mac signs. This is the general request, not a client for any one route: the
 * caller names the route and reads the JSON it answers.
 */

import { Command, ValidationError } from "@cliffy/command";
import { signedFetch } from "../lib/first-party.ts";
import { cliText } from "../lib/cli-name.ts";

export const fetchCommand = new Command()
  .name("fetch")
  .description(
    "Send one request to a first-party Common Fabric service, signed as " +
      "your identity, and print what it answers. A body, as JSON, is read " +
      "from stdin for any method but GET and HEAD.",
  )
  .arguments("<url:string>")
  .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .option("-i,--identity <path:string>", "Path to an identity keyfile.")
  .option("-X,--method <method:string>", "The HTTP method.", {
    default: "GET",
  })
  .example(
    cliText("cf fetch https://cfs.example.ts.net/config"),
    "Read the service's settings as the owner.",
  )
  .example(
    cliText(
      `echo '{"name":"Making"}' | cf fetch -X POST https://cfs.example.ts.net/command/loom.find`,
    ),
    "Run one of the service's commands.",
  )
  .action((options, url) => fetchAction(options, url));

/**
 * The process streams `cf fetch` uses: where a body is read from, and where
 * the answer goes. Each defaults to the process's own.
 */
export interface FetchDeps {
  stdin?: ReadableStream<Uint8Array>;
  stdout?: Pick<typeof Deno.stdout, "write">;
}

/** Sends the request and prints the answer, ending it with a newline. */
export async function fetchAction(
  options: { identity?: string; method: string },
  url: string,
  { stdin, stdout = Deno.stdout }: FetchDeps = {},
): Promise<void> {
  if (!options.identity) {
    throw new ValidationError(
      'Missing required option: "--identity", or "CF_IDENTITY".',
    );
  }
  const method = options.method.toUpperCase();
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await new Response(stdin ?? Deno.stdin.readable).text();
  const text = await signedFetch({
    url,
    method,
    body,
    identity: options.identity,
  });
  await stdout.write(
    new TextEncoder().encode(text.endsWith("\n") ? text : `${text}\n`),
  );
}
