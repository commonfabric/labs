/**
 * Runs one compiled pattern on an argument and prints its result.
 *
 * `deno run -A base/pattern-compiler/exec/run.ts <artifact.json> [argument.json]`
 *
 * The artifact is the output of `pattern-compiler emit path/to/module.tsx`.
 * The first pattern of the first module is run. The argument is `{}` where
 * none is given.
 */
import { type Artifact, Instance } from "./executor.ts";

if (import.meta.main) {
  const [artifactFile, argumentFile] = Deno.args;
  const emitted = JSON.parse(await Deno.readTextFile(artifactFile)) as {
    patterns: Artifact[];
  }[];
  const argument = argumentFile === undefined
    ? {}
    : JSON.parse(await Deno.readTextFile(argumentFile));
  const instance = new Instance(emitted[0].patterns[0], argument);
  console.log(JSON.stringify(
    {
      result: instance.result(),
      stateCells: instance.stateCells(),
      documents: instance.documents(),
      counts: instance.counts,
    },
    null,
    2,
  ));
}
