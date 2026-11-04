import { TestServer } from "./server.ts";
import { Manifest } from "./manifest.ts";
import { buildTestDir } from "./utils.ts";
import { Runner } from "./runner.ts";

const stderrBoundary = Deno.env.get("DENO_WEB_TEST_STDERR_BOUNDARY");
if (stderrBoundary) {
  Deno.stderr.writeSync(
    new TextEncoder().encode(`${stderrBoundary}\n`),
  );
}

// {*_,*.,}test.{ts, tsx, mts, js, mjs, jsx}
const manifest = await Manifest.create(Deno.cwd(), [...Deno.args]);
const server = new TestServer(manifest);
let success = false;

// `Deno.exit()` ends the process where it stands. The status is held here
// and the exit comes after the removal below.
try {
  await buildTestDir(manifest);

  server.start(manifest.requestedPort);
  const port = server.port();

  if (!port) {
    throw new Error(
      `Server could not listen on requested port ${manifest.requestedPort}.`,
    );
  }

  const runner = new Runner(manifest, port);
  success = await runner.run();
} finally {
  await server.stop();
  await manifest.remove();
}

Deno.exit(success ? 0 : 1);
