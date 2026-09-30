// This file is exported separately, and uses DOM parsing
// libraries in tests and some CLI utilities.

import * as htmlparser2 from "htmlparser2";
import * as domhandler from "domhandler";
import * as domserializer from "dom-serializer";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { RenderOptions } from "./render.ts";
import { styleObjectToCssString } from "./render-utils.ts";

const eventListeners = new WeakMap<
  object,
  Map<string, Array<(event: unknown) => void>>
>();

function getNodeEventListeners(node: object) {
  let listeners = eventListeners.get(node);
  if (!listeners) {
    listeners = new Map<string, Array<(event: unknown) => void>>();
    eventListeners.set(node, listeners);
  }
  return listeners;
}

function renderOptionsFromDoc(document: globalThis.Document): RenderOptions {
  return {
    document,
    setProp<T>(
      element: T,
      key: string,
      value: unknown,
    ) {
      const el = element as any;

      // Handle style object specially - convert to CSS string
      if (
        key === "style" &&
        el.attribs &&
        isObjectNotArray(value)
      ) {
        const cssString = styleObjectToCssString(value as Record<string, any>);
        el.attribs["style"] = cssString;
        return;
      }

      // Handle data-* attributes specially - they need to be set as HTML attributes
      // to populate the dataset property correctly
      if (key.startsWith("data-") && el.attribs) {
        // If value is null or undefined, remove the attribute
        if (value == null) {
          if (key in el.attribs) {
            delete el.attribs[key];
          }
        } else {
          el.attribs[key] = String(value);
        }
        return;
      }

      // For non-data attributes, use the existing logic
      let attrValue;
      if (typeof value === "string") {
        attrValue = value;
      } else if (Array.isArray(value)) {
        attrValue = `[${Array(`${value.length}`)}]`;
      } else if (typeof value === "object") {
        // for objects, JSON.stringify is unruly -- just render
        // as a "[binding]".
        attrValue = "[binding]";
      } else {
        attrValue = `${value}`;
      }
      el.attribs[key] = attrValue;
    },
  };
}

export class MockDoc {
  document: globalThis.Document;
  renderOptions: RenderOptions;
  constructor(html: string) {
    const { DomUtils, DomHandler, Parser } = htmlparser2;
    const handler = new DomHandler();
    const parser = new Parser(handler);
    parser.end(html);

    // Extend `Node` types with self manipulation functionality
    // used by the renderer.
    const nodeExt = {
      remove: {
        value() {
          return DomUtils.removeElement(this as any);
        },
      },
      replaceWith: {
        value(newNode: any) {
          return DomUtils.replaceElement(this as any, newNode);
        },
      },
      innerHTML: {
        get() {
          return domserializer.render((this as any).children);
        },
        set(value: string) {
          if (value !== "") {
            throw new Error(
              "Only the empty string is supported when setting innerHTML.",
            );
          }
          const children = DomUtils.getChildren(this as any);
          for (const child of children) {
            DomUtils.removeElement(child);
          }
        },
      },
    };

    // Extend `NodeWithChildren` types with query and manipulation functionality
    // used by the renderer.
    const nodeWithChildrenExt = {
      getElementsByTagName: {
        value(tagName: string) {
          // @ts-ignore: Cast to Node, we only
          // want to query the children, do not match `this`.
          const node = this as domhandler.NodeWithChildren;
          return DomUtils.getElementsByTagName(tagName, node.children, true);
        },
      },
      append: {
        value(nodeOrText: any) {
          return DomUtils.appendChild(this as any, nodeOrText);
        },
      },
      appendChild: {
        value(nodeOrText: any) {
          return DomUtils.appendChild(this as any, nodeOrText);
        },
      },
      removeChild: {
        value(child: any) {
          DomUtils.removeElement(child);
          return child;
        },
      },
      insertBefore: {
        value(child: any, ref: any | null) {
          return ref !== null
            ? DomUtils.prepend(ref, child)
            : DomUtils.appendChild(this as any, child);
        },
      },
      getAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            return (this as Element).attribs[attrName];
          }
        },
      },
      setAttribute: {
        value(attrName: string, value: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            (this as Element).attribs[attrName] = value;
          }
        },
      },
      hasAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            return attrName in (this as Element).attribs;
          }
          return false;
        },
      },
      removeAttribute: {
        value(attrName: string) {
          if (this && (this as any).attribs) {
            // @ts-ignore: domhandler.Element has `attribs`
            delete (this as Element).attribs[attrName];
          }
        },
      },
      dataset: {
        get() {
          const el = this as any;
          if (!el.attribs) return {};
          const dataset: Record<string, string> = {};
          for (const key in el.attribs) {
            if (key.startsWith("data-")) {
              const dataKey = key.slice(5).replace(
                /-([a-z])/g,
                (_, char) => char.toUpperCase(),
              );
              dataset[dataKey] = el.attribs[key];
            }
          }
          return dataset;
        },
      },
      addEventListener: {
        value(type: string, listener: (event: unknown) => void) {
          const listeners = getNodeEventListeners(this as object);
          const existing = listeners.get(type) ?? [];
          existing.push(listener);
          listeners.set(type, existing);
        },
      },
      removeEventListener: {
        value(type: string, listener: (event: unknown) => void) {
          const listeners = getNodeEventListeners(this as object).get(type);
          if (!listeners) return;
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
      dispatchEvent: {
        value(event: { type?: string }) {
          if (!event?.type) return;
          const listeners = getNodeEventListeners(this as object).get(
            event.type,
          ) ?? [];
          for (const listener of [...listeners]) {
            listener(event);
          }
        },
      },
    };

    // Extend `Document` with element creation methods
    // used by the renderer.
    const docExt = {
      body: {
        get() {
          // @ts-ignore: domhandler.Document is also a domhandler.Node
          return (this as domhandler.Node).getElementsByTagName("body")[0];
        },
      },
      createElement: {
        value(
          name: string,
          options?: { [name: string]: string },
        ) {
          return new domhandler.Element(name, options ?? {});
        },
      },
      createTextNode: {
        value(text: string) {
          return new domhandler.Text(text);
        },
      },
      getElementById: {
        value(id: string) {
          return DomUtils.getElementById(id, this as any, true);
        },
      },
    };

    if (!("remove" in domhandler.Node.prototype)) {
      Object.defineProperties(domhandler.Node.prototype, nodeExt);
    }
    if (!("textContent" in domhandler.Text.prototype)) {
      Object.defineProperties(domhandler.Text.prototype, {
        textContent: {
          get() {
            return (this as domhandler.Text).data;
          },
          set(value: string) {
            (this as domhandler.Text).data = value;
          },
        },
        nodeValue: {
          get() {
            return (this as domhandler.Text).data;
          },
          set(value: string) {
            (this as domhandler.Text).data = value;
          },
        },
      });
    }
    if (!("getElementsByTagName" in domhandler.NodeWithChildren.prototype)) {
      Object.defineProperties(
        domhandler.NodeWithChildren.prototype,
        nodeWithChildrenExt,
      );
    }
    if (!("createElement" in domhandler.Document.prototype)) {
      Object.defineProperties(domhandler.Document.prototype, docExt);
    }

    // @ts-ignore: Force this to type as a web Document.
    this.document = handler.root as globalThis.Document;
    this.renderOptions = renderOptionsFromDoc(this.document);
  }
}
