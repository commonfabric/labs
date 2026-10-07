import type { Cell, Runtime, RuntimeProgram } from "@commonfabric/runner";
import { setPatternRepository } from "@commonfabric/runner";
import { type NameSchema, nameSchema } from "@commonfabric/runner/schemas";
import type { PiecesController } from "../src/ops/pieces-controller.ts";

/**
 * Installs `program` as the root of the controller's space, the way a test
 * stands in for the open that creates one.
 *
 * `PiecesController.recreateDefaultPattern()` refuses an identity Home, and
 * `ensureDefaultPattern()` creates one only from the system source over HTTP.
 * A test that wants a Home running source of its own therefore does what
 * first open does with the source it has: compiles the program, runs it into
 * a fresh cell, and links that cell as the space's root. No provenance URL is
 * stamped, which is what a custom root looks like; `repository` records a
 * locator the way a custom deployment would.
 */
export async function installCustomRoot(
  runtime: Runtime,
  controller: PiecesController,
  program: RuntimeProgram,
  options: { repository?: string } = {},
): Promise<Cell<NameSchema>> {
  const space = controller.getSpace();
  const pattern = await runtime.patternManager.compilePattern(program, {
    space,
  });
  let root!: Cell<NameSchema>;
  const { error } = await runtime.editWithRetry((tx) => {
    root = runtime.getCell<NameSchema>(
      space,
      `test-root-${crypto.randomUUID()}`,
      nameSchema,
      tx,
    );
    runtime.run(tx, pattern, {}, root);
    if (options.repository !== undefined) {
      setPatternRepository(root, tx, options.repository);
    }
  });
  if (error) {
    throw new Error(
      `Installing the test root failed because storage returned ${error.name}: ${error.message}`,
      { cause: error },
    );
  }
  await controller.linkDefaultPattern(root);
  await runtime.idle();
  return root;
}
