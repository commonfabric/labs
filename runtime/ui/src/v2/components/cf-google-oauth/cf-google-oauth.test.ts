// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { type AuthData, CFGoogleOAuth } from "./index.ts";

/** A mounted component whose auth cell holds `auth`. */
function googleOAuth(auth: AuthData): Promise<CFGoogleOAuth> {
  const element = new CFGoogleOAuth();
  element.auth = createMockCellHandle(auth);
  element.scopes = ["email"];
  return mount(element);
}

/** The component's one button. */
function button(element: CFGoogleOAuth): HTMLButtonElement {
  return element.shadowRoot!.querySelector("button")!;
}

describe("CFGoogleOAuth", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.body.replaceChildren();
  });

  it("renders a button in Google's color that offers to authenticate with Google", async () => {
    const element = await googleOAuth({});

    expect(button(element).textContent!.trim()).toBe(
      "Authenticate with Google",
    );
    expect(button(element).getAttribute("style")).toContain("#4285f4");
  });

  it("reads the access token from the `token` field, not `accessToken`", async () => {
    const signedIn = await googleOAuth({ token: "ya29.token" });
    const elsewhere = await googleOAuth({ accessToken: "ya29.token" });

    expect(button(signedIn).textContent!.trim()).toBe("Logout");
    expect(button(elsewhere).textContent!.trim()).toBe(
      "Authenticate with Google",
    );
  });

  it("starts the flow at Google's login endpoint when clicked", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    // The response never arrives, so the flow stops at the request.
    globalThis.fetch = (input, init) => {
      requests.push({ url: String(input), init });
      return new Promise(() => {});
    };
    const element = await googleOAuth({});

    button(element).click();

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/integrations/google-oauth/login", "POST"],
    ]);
    expect(JSON.parse(String(requests[0].init?.body)).scopes).toEqual([
      "email",
    ]);
  });
});
