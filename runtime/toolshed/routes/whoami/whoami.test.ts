import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import router from "./whoami.index.ts";
import { createTestApp } from "@/lib/create-app.ts";

describe("whoami", () => {
  const app = createTestApp(router);

  it("returns the profile the Tailscale headers name", async () => {
    const response = await app.request("/api/whoami", {
      headers: {
        "tailscale-user-name": "Ada Lovelace",
        "tailscale-user-login": "ada@example.com",
        "tailscale-user-profile-pic": "https://example.com/ada.png",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      shortName: "ada",
      avatar: "https://example.com/ada.png",
    });
  });

  it("returns the system profile for a request with no Tailscale headers", async () => {
    const response = await app.request("/api/whoami");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: null,
      email: null,
      shortName: "system",
      avatar: null,
    });
  });
});
