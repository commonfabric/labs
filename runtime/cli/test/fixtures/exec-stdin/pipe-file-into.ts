/**
 * Runs Deno with the arguments after the first, feeding it the contents of the
 * file the first names on stdin, and exits with its code.
 */
const [input, ...args] = Deno.args;
const child = new Deno.Command(Deno.execPath(), { args, stdin: "piped" })
  .spawn();
const writer = child.stdin.getWriter();
await writer.write(await Deno.readFile(input));
await writer.close();
Deno.exit((await child.status).code);
