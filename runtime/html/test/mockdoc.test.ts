import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { MockDoc } from "../src/mock-doc.ts";

describe("MockDoc", () => {
  it("should render as innerHTML", () => {
    const mock = new MockDoc(
      `<!DOCTYPE html><html><body><div id="root"><span>hello</span></div></body></html>`,
    );
    const root = mock.document.getElementById("root")!;
    assert(root.innerHTML === "<span>hello</span>");
  });

  it("should render as innerHTML after manipulation", () => {
    const mock = new MockDoc(
      `<!DOCTYPE html><html><body><div id="root"><span>hello</span></div></body></html>`,
    );
    const root = mock.document.getElementById("root")!;
    const el = mock.document.createElement("div");
    el.appendChild(mock.document.createTextNode("hi"));
    root.appendChild(el);
    assert(root.innerHTML === "<span>hello</span><div>hi</div>");
    assert(
      mock.document.body.innerHTML ===
        '<div id="root"><span>hello</span><div>hi</div></div>',
    );
    const root2 = mock.document.getElementById("root")!;
    assert(root2.innerHTML === "<span>hello</span><div>hi</div>");
  });

  it("should reflect textContent updates in innerHTML", () => {
    const mock = new MockDoc(
      `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
    );
    const root = mock.document.getElementById("root")!;
    const text = mock.document.createTextNode("0");

    root.appendChild(text);
    assertEquals(root.innerHTML, "0");

    text.textContent = "1";
    assertEquals(root.innerHTML, "1");
  });

  describe("renderOptions.setProp", () => {
    const element = () => {
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"></div></body></html>`,
      );
      const el = mock.document.createElement("div");
      const setProp = (key: string, value: unknown) =>
        mock.renderOptions.setProp!(el, key, value);
      return { el, setProp };
    };

    it("writes a style object as a CSS string", () => {
      const { el, setProp } = element();

      setProp("style", { backgroundColor: "red", width: "1px" });

      expect(el.getAttribute("style")).toBe(
        "background-color: red; width: 1px",
      );
    });

    it("writes a `data-` value as a string, and removes it for `null`", () => {
      const { el, setProp } = element();

      setProp("data-count", 3);
      expect(el.getAttribute("data-count")).toBe("3");
      expect(el.dataset).toEqual({ count: "3" });

      setProp("data-count", null);
      expect(el.hasAttribute("data-count")).toBe(false);
      setProp("data-absent", undefined);
      expect(el.hasAttribute("data-absent")).toBe(false);
    });

    it("writes other values as attribute text by their kind", () => {
      const { el, setProp } = element();

      setProp("title", "plain");
      setProp("items", [1, 2, 3]);
      setProp("binding", { a: 1 });
      setProp("count", 4);
      setProp("style", "color: blue");

      expect([
        el.getAttribute("title"),
        el.getAttribute("items"),
        el.getAttribute("binding"),
        el.getAttribute("count"),
        el.getAttribute("style"),
      ]).toEqual(["plain", "[3]", "[binding]", "4", "color: blue"]);
    });
  });

  describe("node extensions", () => {
    const doc = () =>
      new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"><b id="first"></b></div></body></html>`,
      ).document;

    it("clears children when `innerHTML` is set to the empty string, and refuses other markup", () => {
      const document = doc();
      const root = document.getElementById("root")!;

      expect(() => {
        root.innerHTML = "<i></i>";
      }).toThrow("Only the empty string is supported when setting innerHTML.");
      expect(root.innerHTML).toBe('<b id="first"></b>');

      root.innerHTML = "";
      expect(root.innerHTML).toBe("");
    });

    it("removes, replaces and inserts nodes", () => {
      const document = doc();
      const root = document.getElementById("root")!;
      const first = document.getElementById("first")!;

      const second = document.createElement("i");
      root.insertBefore(second, first);
      expect(root.innerHTML).toBe('<i></i><b id="first"></b>');

      const last = document.createElement("u");
      root.insertBefore(last, null);
      expect(root.innerHTML).toBe('<i></i><b id="first"></b><u></u>');

      first.replaceWith(document.createTextNode("t"));
      second.remove();
      expect(root.innerHTML).toBe("t<u></u>");

      expect(root.removeChild(last)).toBe(last);
      expect(root.innerHTML).toBe("t");

      root.append(document.createElement("s"));
      expect(root.innerHTML).toBe("t<s></s>");
    });

    it("reads, tests and removes attributes", () => {
      const document = doc();
      const root = document.getElementById("root")!;

      root.setAttribute("data-long-name", "v");

      expect(root.hasAttribute("data-long-name")).toBe(true);
      expect(root.dataset).toEqual({ longName: "v" });
      root.removeAttribute("data-long-name");
      expect(root.hasAttribute("data-long-name")).toBe(false);
      expect(root.getAttribute("data-long-name")).toBeUndefined();
    });

    it("reports no attributes on a node that cannot hold them", () => {
      const document = doc();
      const node = document as unknown as HTMLElement;

      node.setAttribute("title", "x");

      expect(node.hasAttribute("title")).toBe(false);
      expect(node.getAttribute("title")).toBeUndefined();
      expect(node.dataset).toEqual({});
    });

    it("finds elements by tag name beneath a node but not the node itself", () => {
      const document = doc();
      const root = document.getElementById("root")!;

      expect(root.getElementsByTagName("b").length).toBe(1);
      expect(root.getElementsByTagName("div").length).toBe(0);
      expect(document.body.getElementsByTagName("div").length).toBe(1);
    });

    it("delivers dispatched events to the listeners still registered", () => {
      const root = doc().getElementById("root")!;
      const heard: string[] = [];
      const first = () => heard.push("first");
      const second = () => heard.push("second");
      root.addEventListener("ping", first);
      root.addEventListener("ping", second);

      root.dispatchEvent({ type: "ping" } as Event);
      root.removeEventListener("ping", first);
      root.removeEventListener("ping", first);
      root.removeEventListener("pong", second);
      root.dispatchEvent({ type: "ping" } as Event);
      root.dispatchEvent({} as Event);

      expect(heard).toEqual(["first", "second", "second"]);
    });

    it("exposes a text node's data as `nodeValue`", () => {
      const text = doc().createTextNode("a");

      text.nodeValue = "b";

      expect(text.nodeValue).toBe("b");
      expect(text.textContent).toBe("b");
    });
  });
});
