import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { navigateReporter } from "../lib/piece.ts";

const signer = await Identity.fromPassphrase("navigateReporter");
const space = signer.did();

describe("navigateReporter()", () => {
  let runtime: Runtime;
  let lines: string[];
  let failures: string[];
  let report: ReturnType<typeof navigateReporter>;

  beforeEach(() => {
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    lines = [];
    failures = [];
    report = navigateReporter(
      (message) => lines.push(message),
      (message) => failures.push(message),
    );
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  it("writes the line naming the piece a pattern navigated to", () => {
    const target = runtime.getCell(space, "navigated-to");

    report(target);

    expect(lines).toEqual([`navigateTo new piece id ${pieceId(target)}`]);
    expect(failures).toEqual([]);
  });

  it("reports a target whose id cannot be read as a failure", () => {
    const target = runtime.getCellFromLink({
      id: "urn:not-an-entity",
      space,
      path: [],
    });

    report(target);

    expect(lines).toEqual([]);
    expect(failures).toEqual([
      "navigateTo callback error: Invalid URI: urn:not-an-entity",
    ]);
  });

  it("reports a target whose entity id is empty as missing its piece id", () => {
    report(runtime.getCellFromLink({ id: "of:", space, path: [] }));

    expect(failures).toEqual(["navigateTo: target missing piece id"]);
    expect(lines).toEqual([]);
  });
});
