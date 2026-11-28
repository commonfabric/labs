import { expect } from "@std/expect";

import { completeOpenAICodexDeviceAuthorization } from "../../src/auth/openai-codex.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("completeOpenAICodexDeviceAuthorization()", () => {
  for (const status of [403, 404]) {
    it(`continues polling a status-only ${status} response until local expiry`, async () => {
      let clock = 0;
      const waits: number[] = [];
      let polls = 0;
      const result = completeOpenAICodexDeviceAuthorization({
        device: {
          deviceAuthId: "pending-device",
          userCode: "PENDING",
          intervalMs: 1_000,
          verificationUrl: "https://auth.openai.com/codex/device",
        },
        expiresInMs: 2_000,
        now: () => clock,
        wait: (milliseconds) => {
          waits.push(milliseconds);
          clock += milliseconds;
          return Promise.resolve();
        },
        fetchFn: (_input, init) => {
          expect(JSON.parse(String(init?.body))).toEqual({
            device_auth_id: "pending-device",
            user_code: "PENDING",
          });
          polls++;
          return Promise.resolve(new Response("", { status }));
        },
      });

      await expect(result).rejects.toThrow(
        "OpenAI Codex device authorization expired",
      );
      expect(polls).toBe(2);
      expect(waits).toEqual([1_000, 1_000]);
    });
  }

  it("throws when a successful device token response lacks the code verifier", async () => {
    let exchanges = 0;
    const result = completeOpenAICodexDeviceAuthorization({
      device: {
        deviceAuthId: "device",
        userCode: "CODE",
        intervalMs: 1_000,
        verificationUrl: "https://auth.openai.com/codex/device",
      },
      now: () => 0,
      wait: () => Promise.resolve(),
      fetchFn: (input) => {
        if (String(input).endsWith("/oauth/token")) exchanges++;
        return Promise.resolve(
          new Response(JSON.stringify({ authorization_code: "code" })),
        );
      },
    });

    await expect(result).rejects.toThrow(
      "OpenAI Codex device token response is missing required fields",
    );
    expect(exchanges).toBe(0);
  });
});
