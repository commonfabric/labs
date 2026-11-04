import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { completeOpenAICodexDeviceAuthorization } from "../../src/auth/openai-codex.ts";

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
});
