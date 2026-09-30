/**
 * `cf wish`'s read options, against the emulated runtime the rest of the wish
 * read is exercised on (test/wish.test.ts). A wish resolves a query rather
 * than an address, but it still terminates in a cell, and that cell is what
 * these shape.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { projectWishValue, resolveWish } from "../lib/wish.ts";
import {
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";

const userIdentity = await Identity.fromPassphrase("cf-wish-read-options-user");

const profileSpace =
  (await Identity.fromPassphrase("cf-wish-read-options-profile")).did();

describe("cf wish read options", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: userIdentity });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedProfile(
    options: { bio?: boolean } = {},
  ): Promise<void> {
    let tx = runtime.edit();
    const profileSpaceCell = runtime.getSpaceCell(profileSpace, undefined, tx);
    const profileCell = runtime.getCell(
      profileSpace,
      "profile-default",
      undefined,
      tx,
    );
    profileCell.set({
      name: "Ada Lovelace",
      initialNameApplied: "Ada Lovelace",
      avatar: "ada.png",
      ...(options.bio === false
        ? {}
        : { bio: "Mathematician & first programmer." }),
      elements: [
        { title: "Analytical Engine", done: true },
        { title: "Bernoulli numbers", done: false },
      ],
    });
    profileSpaceCell.key("defaultPattern").set(profileCell);
    await tx.commit();
    await runtime.idle();

    tx = runtime.edit();
    const homeSpaceCell = runtime.getHomeSpaceCell(tx);
    const homeDefaultCell = runtime.getCell(
      userIdentity.did(),
      "home-default-profile-link",
      undefined,
      tx,
    );
    homeDefaultCell.key("profiles").set([
      runtime.getCell(profileSpace, "profile-default", undefined, tx),
    ]);
    // deno-lint-ignore no-explicit-any
    (homeSpaceCell as any).key("defaultPattern").set(homeDefaultCell);
    await tx.commit();
    await runtime.idle();
  }

  it("projects the resolved target to the fields --select names", async () => {
    await seedProfile();
    const selection = await parseCellSelectionOptions({ select: "name,bio" });

    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      selection,
    });

    expect(error).toBeUndefined();
    // Named fields present AND unnamed fields absent. A selection dropped on
    // the way through answers the whole profile, which satisfies the first
    // half of this and fails the second.
    expect(result).toEqual({
      name: "Ada Lovelace",
      bio: "Mathematician & first programmer.",
    });
  });

  it("filters an array target with --filter", async () => {
    await seedProfile();
    const selection = await parseCellSelectionOptions({ filter: ".done" });

    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      path: ["elements"],
      selection,
    });

    expect(error).toBeUndefined();
    // One of the two elements, not both and not none: a predicate that was
    // never evaluated answers both, and one evaluated against nothing answers
    // neither.
    expect(result).toEqual([{ title: "Analytical Engine", done: true }]);
  });

  it("answers a marked position with the resolved target's own address", async () => {
    await seedProfile();
    const selection = await parseCellSelectionOptions({ select: "@" });

    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      selection,
    });

    expect(error).toBeUndefined();
    // The profile's own cell, in its own space — not the wish's result cell in
    // the reading space, and not the detached copy the handle-stripping walk
    // would produce if the selection ran after it. One canonical reference
    // string carries all of that: the profile's space differs from the space
    // the wish read against, so it rides in front as `@did`.
    expect(result).toEqual({
      $link: `//${profileSpace}/${
        runtime.getCell(profileSpace, "profile-default")
          .getAsNormalizedFullLink().id
      }`,
    });

    // And the address survives the walk that strips handles, which is the
    // step it was composed ahead of. `projectWishValue` is what `cf wish`
    // renders through, so an address it flattened would never reach stdout.
    expect(projectWishValue(result)).toEqual(result);
  });

  it("answers a marked position the wish resolved to but nothing has set", async () => {
    await seedProfile({ bio: false });
    const selection = await parseCellSelectionOptions({ select: "@" });

    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      path: ["bio"],
      selection,
    });

    expect(error).toBeUndefined();
    // "The wish matched nothing" and "the wish matched a cell holding nothing"
    // are different facts, and only the first is an absent result. A target
    // whose value is unset still HAS an address, which is the whole of what a
    // marked position asks for — deciding absence from the dereferenced value
    // answers null here and loses an address that exists.
    // The path rides inside the one reference string, after the id.
    expect(result).toEqual({
      $link: `//${profileSpace}/${
        runtime.getCell(profileSpace, "profile-default")
          .getAsNormalizedFullLink().id
      }/bio`,
    });
  });

  it("refuses a --filter over a target that is not an array", async () => {
    await seedProfile();
    const selection = await parseCellSelectionOptions({ filter: ".done" });

    // The refusal the other arrivals report for the same mistake, reported
    // here too rather than answered with an empty result.
    await expect(
      resolveWish(runtime, userIdentity.did(), {
        query: "#profile",
        selection,
      }),
    ).rejects.toThrow("--filter can only be applied to an array");
  });

  it("leaves a wish that matched nothing an ordinary empty outcome", async () => {
    // No profile seeded: the wish matches nothing. A selection must not turn
    // that into an error — a query matching nothing is an outcome, not a
    // failure — so the selection is never reached and the empty result and
    // its message come back unchanged.
    const selection = await parseCellSelectionOptions({ select: "name" });

    const { result, error } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
      selection,
    });

    expect(result).toBeNull();
    expect(error).toBe("No profile exists yet");
  });

  it("reads the whole target when no read option is given", async () => {
    await seedProfile();

    const { result } = await resolveWish(runtime, userIdentity.did(), {
      query: "#profile",
    });

    // The unselected read is unchanged: every field, including the ones the
    // projections above drop.
    expect((result as { avatar?: string })?.avatar).toBe("ada.png");
    expect((result as { name?: string })?.name).toBe("Ada Lovelace");
  });

  it("refuses a projection that materializes nothing over a target that resolved", async () => {
    await seedProfile();
    // An object-rooted schema over a scalar target keeps nothing. The wish DID
    // resolve — `#profileName` is a string — so answering "nothing" would be
    // indistinguishable from a wish that matched nothing, which is a
    // different fact.
    const selection = await parseCellSelectionOptions({
      schema: '{"type":"object","properties":{"name":{"type":"string"}}}',
    });

    let thrown: unknown;
    try {
      await resolveWish(runtime, userIdentity.did(), {
        query: "#profileName",
        selection,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CellSelectionError);
    expect((thrown as Error).message).toContain(
      'Cannot shape the result of wish "#profileName"',
    );
    expect((thrown as Error).message).toContain("matched nothing");
  });
});
