/**
 * What a stored scoped link at an output location decides for a result
 * write. A broad output location that holds a link to its own narrower-scoped
 * instance was placed there by a run whose reads narrowed. A run whose reads
 * did not narrow writes behind that link, into its own instance, rather than
 * over it: the link is what every reader of the broad location follows to its
 * own instance, so it stays as it is.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createCell } from "../src/cell.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { sendValueToBinding } from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("output binding scoped link");
const space = signer.did();

describe("output-binding-scoped-link", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
    seq++;
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * An output location whose broad instance links to its own session
   * instance, which holds `stored`; the write redirect a binding names it by;
   * and the result cell the write is sent for.
   */
  const scopedOutput = (stored: unknown) => {
    const output = runtime.getCell<unknown>(
      space,
      `output-${seq}`,
      undefined,
      tx,
    );
    const broad = output.getAsNormalizedFullLink();
    const session = createCell<unknown>(
      runtime,
      { ...broad, scope: "session" },
      tx,
    );
    session.set(stored);
    output.setRaw(
      createSigilLinkFromParsedLink(session.getAsNormalizedFullLink(), {
        base: broad,
      }),
    );
    const binding = createSigilLinkFromParsedLink(broad, {
      overwrite: "redirect",
    });
    const result = runtime.getCell<unknown>(
      space,
      `result-${seq}`,
      undefined,
      tx,
    );
    return { output, session, binding, result };
  };

  it("writes behind a stored session link when the run's reads did not narrow", () => {
    const { output, session, binding, result } = scopedOutput(1);

    sendValueToBinding(tx, result, undefined, binding, 2, {});

    expect(session.get()).toBe(2);
    const kept = parseLink(output.getRaw(), output);
    expect(kept).toMatchObject({
      id: output.getAsNormalizedFullLink().id,
      scope: "session",
    });
  });

  it("writes behind a stored session link when the run's reads narrowed less far", () => {
    const { output, session, binding, result } = scopedOutput(1);

    sendValueToBinding(tx, result, undefined, binding, 3, {
      narrowestReadScope: "user",
    });

    expect(session.get()).toBe(3);
    expect(parseLink(output.getRaw(), output)).toMatchObject({
      scope: "session",
    });
  });

  /**
   * An output location whose broad instance links to its user instance,
   * whose user instance links to its session instance, which holds `stored`.
   */
  const chainedOutput = (stored: unknown) => {
    const output = runtime.getCell<unknown>(
      space,
      `chain-${seq}`,
      undefined,
      tx,
    );
    const broad = output.getAsNormalizedFullLink();
    const user = createCell<unknown>(runtime, { ...broad, scope: "user" }, tx);
    const session = createCell<unknown>(
      runtime,
      { ...broad, scope: "session" },
      tx,
    );
    session.set(stored);
    user.setRaw(
      createSigilLinkFromParsedLink(session.getAsNormalizedFullLink(), {
        base: user.getAsNormalizedFullLink(),
      }),
    );
    output.setRaw(
      createSigilLinkFromParsedLink(user.getAsNormalizedFullLink(), {
        base: broad,
      }),
    );
    const binding = createSigilLinkFromParsedLink(broad, {
      overwrite: "redirect",
    });
    const result = runtime.getCell<unknown>(
      space,
      `result-${seq}`,
      undefined,
      tx,
    );
    return { output, user, session, binding, result };
  };

  it("keeps every hop of a stored chain when the run's reads narrowed to its middle", () => {
    const { output, user, session, binding, result } = chainedOutput(1);

    sendValueToBinding(tx, result, undefined, binding, 2, {
      narrowestReadScope: "user",
    });

    expect(session.get()).toBe(2);
    expect(parseLink(output.getRaw(), output)).toMatchObject({ scope: "user" });
    expect(parseLink(user.getRaw(), user)).toMatchObject({ scope: "session" });
  });

  it("keeps every hop of a stored chain when the run's reads did not narrow", () => {
    const { output, user, session, binding, result } = chainedOutput(1);

    sendValueToBinding(tx, result, undefined, binding, 3, {});

    expect(session.get()).toBe(3);
    expect(parseLink(output.getRaw(), output)).toMatchObject({ scope: "user" });
    expect(parseLink(user.getRaw(), user)).toMatchObject({ scope: "session" });
  });

  it("adds the via-user hop to a one-hop stored chain under server execution", () => {
    setServerExecutionConfig(true);
    const { output, session, binding, result } = scopedOutput(1);
    const broad = output.getAsNormalizedFullLink();

    sendValueToBinding(tx, result, undefined, binding, 2, {});

    expect(session.get()).toBe(2);
    expect(parseLink(output.getRaw(), output)).toMatchObject({
      id: broad.id,
      scope: "user",
    });
    const user = runtime.getCellFromLink(
      { ...broad, scope: "user" },
      undefined,
      tx,
    );
    expect(parseLink(user.getRaw(), user)).toMatchObject({
      id: broad.id,
      scope: "session",
    });
  });

  it("keeps a full stored chain under server execution", () => {
    setServerExecutionConfig(true);
    const { output, user, session, binding, result } = chainedOutput(1);

    sendValueToBinding(tx, result, undefined, binding, 2, {});

    expect(session.get()).toBe(2);
    expect(parseLink(output.getRaw(), output)).toMatchObject({ scope: "user" });
    expect(parseLink(user.getRaw(), user)).toMatchObject({ scope: "session" });
  });

  it("writes a broad output over a plain stored value", () => {
    const output = runtime.getCell<unknown>(
      space,
      `plain-${seq}`,
      undefined,
      tx,
    );
    output.setRaw(1);
    const binding = createSigilLinkFromParsedLink(
      output.getAsNormalizedFullLink(),
      { overwrite: "redirect" },
    );
    const result = runtime.getCell<unknown>(
      space,
      `result-${seq}`,
      undefined,
      tx,
    );

    sendValueToBinding(tx, result, undefined, binding, 2, {});

    expect(output.getRaw()).toBe(2);
  });
});
