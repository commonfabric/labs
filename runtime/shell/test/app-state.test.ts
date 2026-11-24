import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import {
  AppState,
  assertIdentityChangeAllowed,
  clone,
  createAppState,
  isAppStateConfigKey,
  resolveIdentity,
  serialize,
} from "@commonfabric/shell/app-state";

const API_URL = "http://common.test/";
const SPACE_NAME = "common-knowledge";

describe("AppState", () => {
  it("requires logout before switching identities", async () => {
    const first = await Identity.generate({ implementation: "noble" });
    const second = await Identity.generate({ implementation: "noble" });

    assertThrows(
      () => assertIdentityChangeAllowed(first, second),
      Error,
      "Cannot change identity while logged in",
    );

    // Clearing an identity, and re-establishing one from nothing, are both
    // allowed; so is re-establishing the identity already in place.
    assertIdentityChangeAllowed(first, undefined);
    assertIdentityChangeAllowed(undefined, second);
    assertIdentityChangeAllowed(first, first);
  });

  it("accepts only the three display toggles as config keys", () => {
    assert(isAppStateConfigKey("showShellPieceListView"));
    assert(isAppStateConfigKey("showDebuggerView"));
    assert(isAppStateConfigKey("showSidebar"));
    assert(!isAppStateConfigKey("showQuickJumpView"));
    assert(!isAppStateConfigKey("identity"));
    assert(!isAppStateConfigKey("__proto__"));
    assert(!isAppStateConfigKey(""));
    assert(!isAppStateConfigKey(undefined));
    assert(!isAppStateConfigKey(0));
  });

  it("clones the config and the view rather than sharing them", () => {
    const original: AppState = {
      apiUrl: new URL(API_URL),
      view: { spaceName: SPACE_NAME, pieceSlug: "demo" },
      config: { showSidebar: true },
    };

    const copy = clone(original);
    assertEquals(copy.view, original.view);
    assertEquals(copy.config, original.config);
    assert(copy.config !== original.config, "the config is a fresh record.");
    assert(copy.view !== original.view, "the view is a fresh record.");

    copy.config.showSidebar = false;
    (copy.view as { spaceName: string }).spaceName = "elsewhere";
    assertEquals(original.config.showSidebar, true);
    assertEquals(
      (original.view as { spaceName: string }).spaceName,
      SPACE_NAME,
    );
  });

  it("carries a built-in view through a clone", () => {
    const original = createAppState({
      apiUrl: new URL(API_URL),
      view: { builtin: "home" },
      identity: undefined,
    });
    assertEquals(original.config, {});
    assertEquals(clone(original).view, { builtin: "home" });
  });

  it("resolves an identity from either an Identity or an encoded key pair", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const encoded = jsonFromFabricValue(identity.keyPair);

    assertEquals(await resolveIdentity(undefined), undefined);
    assert(await resolveIdentity(identity) === identity);
    assertEquals((await resolveIdentity(encoded))?.did(), identity.did());
  });

  it("refuses an encoding that is not a key pair", async () => {
    // Well-formed in the format and wrong as a payload, which is the case a
    // string arriving over the page boundary can actually be in.
    await assertRejects(
      () => resolveIdentity(jsonFromFabricValue("not a key pair")),
      Error,
      "not a key pair",
    );
  });

  it("serialize", async () => {
    const state: AppState = {
      apiUrl: new URL(API_URL),
      view: {
        spaceName: SPACE_NAME,
      },
      config: {},
    };

    let serialized = serialize(state);
    assert(serialized.apiUrl === API_URL);
    assert((serialized.view as { spaceName: string }).spaceName === SPACE_NAME);
    assertEquals(
      serialized.identityDid,
      undefined,
      "Identity not provided (undefined).",
    );

    // Both implementations, because a DID is the one thing either state of a
    // key pair can produce: the "webcrypto" arm holds `CryptoKey` handles,
    // whose material is unreachable, and a serialized state carries none.
    for (const implementation of ["webcrypto", "noble"] as const) {
      state.identity = await Identity.generate({ implementation });
      serialized = serialize(state);
      assert(serialized.apiUrl === API_URL);
      assertEquals(
        serialized.identityDid,
        state.identity.did(),
        implementation,
      );
    }
  });
});
