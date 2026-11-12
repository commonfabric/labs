import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCell, isStream } from "../src/cell.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { processDefaultValue } from "../src/schema.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("processDefaultValue");
const space = signer.did();

describe("processDefaultValue()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });
  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A link to a fresh document, carrying `schema`. */
  const linkWith = (cause: string, schema: JSONSchema): NormalizedFullLink => ({
    ...runtime.getCell(space, cause, undefined, tx).getAsNormalizedFullLink(),
    schema,
  });

  it("returns a stream handle for a stream position, whatever the default", () => {
    const value = processDefaultValue(
      runtime,
      tx,
      linkWith("stream", { type: "object", asCell: ["stream"] }),
      { ignored: true },
    );

    expect(isStream(value)).toBe(true);
    expect(isStream(
      processDefaultValue(
        runtime,
        tx,
        linkWith("cell", { type: "object", asCell: ["cell"] }),
        {},
      ),
    )).toBe(false);
  });

  it("returns undefined for a handle entry that names no kind", () => {
    // A stored schema arrives as JSON, so an entry can carry a scope and no
    // kind; there is then no handle to make.
    const kindless: JSONSchema = JSON.parse('{"asCell":[{"scope":"user"}]}');

    expect(processDefaultValue(runtime, tx, linkWith("kindless", kindless), 1))
      .toBe(undefined);
    expect(isCell(
      processDefaultValue(
        runtime,
        tx,
        linkWith("kinded", { asCell: [{ kind: "cell", scope: "user" }] }),
        1,
      ),
    )).toBe(true);
  });

  it("fills a required object or array property with an empty container", () => {
    const value = processDefaultValue(
      runtime,
      tx,
      linkWith("required", {
        type: "object",
        properties: {
          o: { type: "object" },
          a: { type: "array" },
          s: { type: "string" },
          optional: { type: "object" },
        },
        required: ["o", "a", "s"],
      }),
      {},
    );

    expect(value).toEqual({ o: {}, a: [] });
  });
});
