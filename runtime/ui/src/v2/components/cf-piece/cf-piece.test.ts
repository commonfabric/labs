// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFPiece } from "./index.ts";

describe("cf-piece", () => {
  afterEach(() => document.body.replaceChildren());

  it("shows its children through a default slot", async () => {
    const element = new CFPiece();
    const child = document.createElement("span");
    element.append(child);

    await mount(element);

    const slot = element.shadowRoot!.querySelector("slot")!;
    expect(slot.name).toBe("");
    expect(slot.assignedElements().length).toBe(1);
    expect(slot.assignedElements()[0] === child).toBe(true);
  });

  it("holds no piece id or space name until one is given", async () => {
    const element = await mount(new CFPiece());

    expect(element.pieceId).toBeNull();
    expect(element.spaceName).toBeNull();
  });

  it("takes its piece id and space name from the `piece-id` and `space-name` attributes", async () => {
    const element = await mount(new CFPiece());

    element.setAttribute("piece-id", "of:piece");
    element.setAttribute("space-name", "home");

    expect(element.pieceId).toBe("of:piece");
    expect(element.spaceName).toBe("home");
  });
});
