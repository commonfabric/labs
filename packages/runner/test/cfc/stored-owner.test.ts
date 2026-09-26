import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { runtimeWritePolicyAuthorization } from "../../src/cfc/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const owner = await Identity.fromPassphrase("stored-owner-owner");
const other = await Identity.fromPassphrase("stored-owner-other");
const space = owner.did();
const WRITER = "test.stored-owner.writer";

// profile-home's field shape: represents the current user, owner-bound,
// written through one builtin.
const fieldSchema: JSONSchema = {
  type: "string",
  default: "seeded",
  ifc: {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    addIntegrity: [{
      kind: "represents-principal",
      subject: { __ctCurrentPrincipal: true },
    }],
    writeAuthorizedBy: [WRITER],
  },
};

describe("stored owner", () => {
  let runtime: Runtime;
  let actingPrincipal: string;

  beforeEach(() => {
    actingPrincipal = owner.did();
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: owner }),
      trustSnapshotProvider: () => ({
        id: actingPrincipal,
        actingPrincipal,
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  /** The principals the stored label at `link` says the value represents. */
  function representedBy(link: NormalizedFullLink): string[] {
    const inspect = runtime.edit();
    const stored = readStoredCfcMetadata(inspect, link);
    inspect.abort();
    return (stored?.labelMap.entries ?? [])
      .flatMap((entry) => entry.label.integrity ?? [])
      .filter((atom) =>
        (atom as { kind?: string }).kind === "represents-principal"
      )
      .map((atom) => (atom as { subject: string }).subject)
      .sort();
  }

  /**
   * Seeds a field with its default, as a piece's setup does; `attributed`
   * marks the transaction as the principal's act, so the seed claims them.
   */
  async function seed(name: string, attributed: boolean) {
    const tx = runtime.edit();
    if (attributed) {
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
    }
    const field = runtime.getCell(space, name, fieldSchema, tx);
    runtime.getCell(space, `${name}-result`, undefined, tx).set({ field });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    return field.getAsNormalizedFullLink();
  }

  /** Writes `value` at `link` through the field's writer, as `principal`. */
  async function writeAs(
    principal: Identity,
    link: NormalizedFullLink,
    value: string,
  ): Promise<string | undefined> {
    actingPrincipal = principal.did();
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity({ kind: "builtin", builtinId: WRITER });
    runtime.getCellFromLink(
      { ...link, schema: fieldSchema },
      undefined,
      tx,
    ).set(value);
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit();
    actingPrincipal = owner.did();
    return error?.message;
  }

  function valueAt(link: NormalizedFullLink): unknown {
    const inspect = runtime.edit();
    const value = inspect.readValueOrThrow(link);
    inspect.abort();
    return value;
  }

  it("refuses another principal's write through the writer to a field its label says the owner represents", async () => {
    const link = await seed("owned", true);
    expect(representedBy(link)).toEqual([owner.did()]);

    expect(await writeAs(other, link, "not theirs")).toContain(
      "ownerPrincipal mismatch",
    );
    expect(valueAt(link)).toBe("seeded");
    expect(representedBy(link)).toEqual([owner.did()]);
  });

  it("accepts the owner's own write, which keeps the field theirs", async () => {
    const link = await seed("owned-edit", true);
    expect(await writeAs(owner, link, "edited")).toBeUndefined();
    expect(valueAt(link)).toBe("edited");
    expect(representedBy(link)).toEqual([owner.did()]);
  });

  it("binds the first principal to write through the writer to a field nobody represents", async () => {
    const link = await seed("unowned", false);
    expect(representedBy(link)).toEqual([]);

    expect(await writeAs(other, link, "claimed")).toBeUndefined();
    expect(valueAt(link)).toBe("claimed");
    expect(representedBy(link)).toEqual([other.did()]);

    // The field is theirs now.
    expect(await writeAs(owner, link, "taken back")).toContain(
      "ownerPrincipal mismatch",
    );
    expect(valueAt(link)).toBe("claimed");
  });
});
