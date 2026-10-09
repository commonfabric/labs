import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { resolveGmailPushSettings } from "./gmail-push.config.ts";

const SERVICE_SPACE =
  "did:key:z6MkGmailPushConfigTestServiceSpaceAAAAAAAAAAAAAA";
const ACCOUNT = "gmail-push@project.iam.gserviceaccount.com";

describe("resolveGmailPushSettings()", () => {
  it("returns the service space as the audience when none is configured", () => {
    const settings = resolveGmailPushSettings(
      { audience: "", serviceAccounts: ACCOUNT },
      SERVICE_SPACE,
    );
    expect(settings.audience).toBe(SERVICE_SPACE);
  });

  it("returns the service space for an audience of only whitespace", () => {
    const settings = resolveGmailPushSettings(
      { audience: "  ", serviceAccounts: ACCOUNT },
      SERVICE_SPACE,
    );
    expect(settings.audience).toBe(SERVICE_SPACE);
  });

  it("returns a configured audience, trimmed", () => {
    const settings = resolveGmailPushSettings(
      { audience: " https://toolshed.test/push ", serviceAccounts: ACCOUNT },
      SERVICE_SPACE,
    );
    expect(settings.audience).toBe("https://toolshed.test/push");
  });

  it("returns `enabled: true` with a service account and no audience", () => {
    const settings = resolveGmailPushSettings(
      { audience: "", serviceAccounts: ACCOUNT },
      SERVICE_SPACE,
    );
    expect(settings.enabled).toBe(true);
  });

  it("returns `enabled: false` without a service account, whatever the audience", () => {
    const settings = resolveGmailPushSettings(
      { audience: "https://toolshed.test/push", serviceAccounts: " , " },
      SERVICE_SPACE,
    );
    expect(settings.enabled).toBe(false);
    expect(settings.serviceAccounts).toEqual([]);
  });

  it("returns each comma-separated service account, trimmed", () => {
    const settings = resolveGmailPushSettings(
      { audience: "", serviceAccounts: ` ${ACCOUNT} , other@p.iam.test ,` },
      SERVICE_SPACE,
    );
    expect(settings.serviceAccounts).toEqual([ACCOUNT, "other@p.iam.test"]);
  });
});
