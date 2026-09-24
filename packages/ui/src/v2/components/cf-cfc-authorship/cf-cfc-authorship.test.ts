import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  authorshipStateForLabel,
  CFCFCAuthorship,
  integrityAtomMatchesAuthor,
} from "./index.ts";

/** A label whose root says its value was written by `sender`. */
const authoredByLabel = (sender: string) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: { integrity: [{ kind: "authored-by", subject: sender }] },
  }],
});

/**
 * The label read through a message's link to a profile owned by `owner`: the
 * message's `authored-by` for `sender` at the root, and the owner's
 * `represents-principal` on each of the profile's owner-protected fields.
 */
const linkedProfileLabel = (sender: string, owner: string) => ({
  version: 1 as const,
  entries: [
    ...authoredByLabel(sender).entries,
    ...["avatar", "bio", "name"].map((field) => ({
      path: [field],
      label: { integrity: [{ kind: "represents-principal", subject: owner }] },
    })),
  ],
});

/**
 * A resolved cell whose document has not loaded: its label reads as missing
 * until `load()` delivers one to its subscribers, as the runtime does with an
 * update when the document arrives. Given `id`, it names that cell in its
 * `ref()`, as a runtime cell handle does.
 */
const unloadedCell = (id?: string) => {
  let label: unknown;
  const subscribers = new Set<
    (value: unknown, cfcLabel?: unknown) => void
  >();
  const options: ({ includeCfcLabel?: boolean } | undefined)[] = [];
  return {
    ...(id === undefined
      ? {}
      : { ref: () => ({ space: "did:example:space", id, path: [] }) }),
    getCfcLabel: () => Promise.resolve(label),
    subscribe(
      callback: (value: unknown, cfcLabel?: unknown) => void,
      subscribeOptions?: { includeCfcLabel?: boolean },
    ) {
      subscribers.add(callback);
      options.push(subscribeOptions);
      callback(undefined, label);
      return () => {
        subscribers.delete(callback);
      };
    },
    subscriberCount: () => subscribers.size,

    /** How many times anything has subscribed. */
    subscribeCalls: () => options.length,

    /** Whether every subscription asked for its updates to carry labels. */
    allAskedForLabels: () =>
      options.length > 0 &&
      options.every((option) => option?.includeCfcLabel === true),

    /** Delivers `next` as the label, and settles the reads it starts. */
    async load(next: unknown) {
      label = next;
      for (const callback of [...subscribers]) {
        callback({ loaded: true }, label);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },

    /**
     * Stores `next` as the label (`undefined` for a document with none) and
     * delivers the value without it, as an update on a subscription that
     * does not carry labels does; settles the reads it starts.
     */
    async loadWithoutDeliveringLabel(next: unknown) {
      label = next;
      for (const callback of [...subscribers]) {
        callback({ loaded: true }, undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

/** An element that reports itself connected, as one in a document does. */
const connectedElement = () => {
  const element = new CFCFCAuthorship();
  Object.defineProperty(element, "isConnected", {
    value: true,
    configurable: true,
  });
  return element;
};

describe("CFCFCAuthorship", () => {
  it("registers the custom element", () => {
    expect(customElements.get("cf-cfc-authorship")).toBe(CFCFCAuthorship);
  });

  it("declares reflected badge placement for mirrored chat rows", () => {
    const element = new CFCFCAuthorship();
    const property = CFCFCAuthorship.properties.badgePlacement;

    expect(element.badgePlacement).toBe("start");
    expect(property.attribute).toBe("badge-placement");
    expect(property.reflect).toBe(true);
  });

  it("verifies object-shaped authored-by integrity atoms", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("verified");
  });

  it("fails closed when the claimed author does not match integrity", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "bob";
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("unverified");
  });

  it("does not report verified when strict descendant text was blocked", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.verifyTextIntegrity = true;
    element.textIntegrityState = "blocked";
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("unverified");
  });

  it("does not verify missing label data", async () => {
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(undefined),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("unknown");
  });

  it("falls back to the resolved cell label for bound prop cells", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(undefined),
      resolveAsCell: () =>
        Promise.resolve({
          getCfcLabel: () => Promise.resolve(cfcLabel),
        }),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("verified");
  });

  it("re-reads the value's resolved label when that cell delivers one", async () => {
    // A resolved cell whose document has not loaded reads as having no label.
    // The component subscribes to that cell and re-reads on the update that
    // carries its label.
    const cfcLabel = authoredByLabel("alice");
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      expect(element.authorshipState).not.toBe("verified");
      expect(resolved.subscriberCount()).toBe(1);
      expect(resolved.allAskedForLabels()).toBe(true);

      await resolved.load(cfcLabel);

      expect(element.authorshipState).toBe("verified");
      expect(resolved.subscriberCount()).toBe(0);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("re-reads the author's resolved label when that cell delivers one", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.value = {
        getCfcLabel: () =>
          Promise.resolve(authoredByLabel("did:example:alice")),
      };
      element.author = {
        get: () => ({ name: "Alice" }),
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      await element.refreshAuthorClaim();
      expect(element.authorshipState).not.toBe("verified");
      expect(resolved.allAskedForLabels()).toBe(true);

      await resolved.load(
        linkedProfileLabel("did:example:alice", "did:example:alice"),
      );

      expect(element.authorshipState).toBe("verified");
      expect(resolved.subscriberCount()).toBe(0);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("keeps one watch across reads while the resolved cell is unloaded", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      await element.refreshLabel();
      expect(resolved.subscriberCount()).toBe(1);
      expect(resolved.subscribeCalls()).toBe(1);

      await resolved.load(authoredByLabel("alice"));

      expect(resolved.subscriberCount()).toBe(0);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("stops watching a resolved cell that loads with no label", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      expect(resolved.subscriberCount()).toBe(1);

      await resolved.loadWithoutDeliveringLabel(undefined);

      expect(resolved.subscriberCount()).toBe(0);
      expect(element.authorshipState).toBe("unknown");
    } finally {
      element.disconnectedCallback();
    }
  });

  it("re-reads the label when an update brings the value without it", async () => {
    // A subscription that is not the first on its backend key may carry no
    // labels, so the label is read from the store once the value arrives.
    const resolved = unloadedCell();
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      expect(element.authorshipState).not.toBe("verified");

      await resolved.loadWithoutDeliveringLabel(authoredByLabel("alice"));

      expect(element.authorshipState).toBe("verified");
      expect(resolved.subscriberCount()).toBe(0);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("moves the watch between resolved cells that have no ref", async () => {
    const first = unloadedCell();
    const second = unloadedCell();
    let resolved = first;
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      expect(first.subscriberCount()).toBe(1);

      resolved = second;
      await element.refreshLabel();

      expect(first.subscriberCount()).toBe(0);
      expect(second.subscriberCount()).toBe(1);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("moves the watch when the source resolves to a different cell", async () => {
    const first = unloadedCell("first");
    const second = unloadedCell("second");
    let resolved = first;
    const element = connectedElement();

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () => Promise.resolve(resolved),
      };

      await element.refreshLabel();
      expect(first.subscriberCount()).toBe(1);

      resolved = second;
      await element.refreshLabel();

      expect(first.subscriberCount()).toBe(0);
      expect(second.subscriberCount()).toBe(1);
    } finally {
      element.disconnectedCallback();
    }
  });

  it("stops watching an unloaded resolved cell when it disconnects", async () => {
    const resolved = unloadedCell();
    const element = connectedElement();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(undefined),
      resolveAsCell: () => Promise.resolve(resolved),
    };

    await element.refreshLabel();
    expect(resolved.subscriberCount()).toBe(1);

    element.disconnectedCallback();

    expect(resolved.subscriberCount()).toBe(0);
  });

  it("uses resolved root authorship when the direct label only has nested entries", async () => {
    const directLabel = {
      version: 1 as const,
      entries: [{
        path: ["argument", "element"],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }],
    };
    const resolvedLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(directLabel),
      resolveAsCell: () =>
        Promise.resolve({
          getCfcLabel: () => Promise.resolve(resolvedLabel),
        }),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("verified");
  });

  it("does not resolve when the direct root label already verifies authorship", async () => {
    const directLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(directLabel),
      resolveAsCell: () => {
        throw new Error("direct root label should avoid resolution");
      },
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("verified");
  });

  it("does not let resolved authorship override direct root authorship", async () => {
    const directLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "bob",
          }],
        },
      }],
    };
    const resolvedLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.author = "alice";
    element.value = {
      getCfcLabel: () => Promise.resolve(directLabel),
      resolveAsCell: () =>
        Promise.resolve({
          getCfcLabel: () => Promise.resolve(resolvedLabel),
        }),
    };

    await element.refreshLabel();

    expect(element.authorshipState).toBe("unverified");
  });

  it("verifies object-shaped bound author claims by id", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    element.author = {
      get: () => ({ id: "alice", name: "Alice Nguyen" }),
      sync: () => Promise.resolve({ id: "alice", name: "Alice Nguyen" }),
      subscribe: () => () => {},
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
  });

  it("verifies author cells whose sync returns the cell object", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    const authorCell = {
      get: () => ({ id: "alice", name: "Alice Nguyen" }),
      sync: () => Promise.resolve(authorCell),
      subscribe: () => () => {},
    };
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    element.author = authorCell;

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
  });

  it("verifies resolved author cells that need sync before get", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    let synced = false;
    const resolvedAuthorCell = {
      get: () => synced ? { id: "alice", name: "Alice Nguyen" } : undefined,
      sync: () => {
        synced = true;
        return Promise.resolve(resolvedAuthorCell);
      },
    };
    const authorCell = {
      get: () => undefined,
      sync: () => Promise.resolve({ opaqueCellHandle: true }),
      resolveAsCell: () => resolvedAuthorCell,
      subscribe: () => () => {},
    };
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    element.author = authorCell;

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
  });

  it("verifies a message against a represented-principal profile cell", async () => {
    const messageLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const profileLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    let profile = { name: "Alice Nguyen" };
    let notify: (() => void) | undefined;
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(messageLabel),
    };
    element.author = {
      get: () => profile,
      getCfcLabel: () => Promise.resolve(profileLabel),
      subscribe: (callback: () => void) => {
        notify = callback;
        return () => {};
      },
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");

    profile = { name: "Alice Updated" };
    notify?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(element.authorshipState).toBe("verified");
    expect(element.authorClaim).toEqual({
      subject: "did:example:alice",
      name: "Alice Updated",
    });
  });

  it("derives a claim from a represented-principal author label", async () => {
    const messageLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const profileLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(messageLabel),
    };
    element.author = {
      getCfcLabel: () => Promise.resolve(profileLabel),
    };
    element.authorName = "Alice Snapshot";

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
    expect(element.authorClaim).toEqual({
      subject: "did:example:alice",
      name: "Alice Snapshot",
    });
  });

  it("derives a represented-principal claim from a resolved author label", async () => {
    const messageLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const directProfileLabel = {
      version: 1 as const,
      entries: [{
        path: ["profile"],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const resolvedProfileLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "represents-principal",
            subject: "did:example:alice",
          }],
        },
      }],
    };
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(messageLabel),
    };
    element.author = {
      get: () => ({ name: "Alice Snapshot" }),
      getCfcLabel: () => Promise.resolve(directProfileLabel),
      resolveAsCell: () =>
        Promise.resolve({
          getCfcLabel: () => Promise.resolve(resolvedProfileLabel),
        }),
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
    expect(element.authorClaim).toEqual({
      subject: "did:example:alice",
      name: "Alice Snapshot",
    });
  });

  it("verifies a message against a profile whose principal is on its fields", async () => {
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(authoredByLabel("did:example:alice")),
    };
    element.author = {
      get: () => ({ name: "Alice" }),
      getCfcLabel: () =>
        Promise.resolve(
          linkedProfileLabel("did:example:alice", "did:example:alice"),
        ),
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("verified");
    expect(element.authorClaim).toEqual({
      subject: "did:example:alice",
      name: "Alice",
    });
  });

  it("reports unverified when the linked profile's owner did not send the message", async () => {
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () =>
        Promise.resolve(authoredByLabel("did:example:mallory")),
    };
    element.author = {
      get: () => ({ name: "Alice" }),
      getCfcLabel: () =>
        Promise.resolve(
          linkedProfileLabel("did:example:mallory", "did:example:alice"),
        ),
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorshipState).toBe("unverified");
  });

  it("does not verify on the claim's own id when the profile's label names two principals", async () => {
    // Without the label's principal, the component would read an author id
    // from the claim's value, which here names the sender.
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () =>
        Promise.resolve(authoredByLabel("did:example:mallory")),
    };
    element.author = {
      get: () => ({ id: "did:example:mallory", name: "Alice" }),
      getCfcLabel: () =>
        Promise.resolve({
          version: 1 as const,
          entries: [
            ...authoredByLabel("did:example:mallory").entries,
            {
              path: ["name"],
              label: {
                integrity: [{
                  kind: "represents-principal",
                  subject: "did:example:alice",
                }],
              },
            },
            {
              path: ["avatar"],
              label: {
                integrity: [{
                  kind: "represents-principal",
                  subject: "did:example:bob",
                }],
              },
            },
          ],
        }),
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();

    expect(element.authorClaim).toBeUndefined();
    expect(element.authorshipState).toBe("unknown");
  });

  it("fails closed when a bound author claim cell changes away from the integrity subject", async () => {
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "authored-by", subject: "alice" }],
        },
      }],
    };
    let author = { id: "alice", name: "Alice Nguyen" };
    let notify: ((value: unknown) => void) | undefined;
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () => Promise.resolve(cfcLabel),
    };
    element.author = {
      get: () => author,
      sync: () => Promise.resolve(author),
      subscribe: (callback: (value: unknown) => void) => {
        notify = callback;
        callback(author);
        return () => {};
      },
    };

    await element.refreshLabel();
    await element.refreshAuthorClaim();
    expect(element.authorshipState).toBe("verified");

    author = { id: "bob", name: "Bob Patel" };
    notify?.(author);

    expect(element.authorshipState).toBe("unverified");
  });
});

describe("CFCFCAuthorship integrity matching", () => {
  it("matches authored-by object atoms by subject", () => {
    expect(integrityAtomMatchesAuthor(
      {
        kind: "authored-by",
        subject: "alice",
      },
      "alice",
      "authored-by",
    )).toBe(true);
    expect(integrityAtomMatchesAuthor(
      {
        kind: "authored-by",
        subject: "alice",
      },
      "bob",
      "authored-by",
    )).toBe(false);
  });

  it("matches object author claims by id without trusting display names", () => {
    expect(integrityAtomMatchesAuthor(
      {
        kind: "authored-by",
        subject: "alice",
      },
      {
        id: "alice",
        name: "Mallory-provided display text",
      },
      "authored-by",
    )).toBe(true);
    expect(integrityAtomMatchesAuthor(
      {
        kind: "authored-by",
        subject: "alice",
      },
      {
        id: "bob",
        name: "Alice Nguyen",
      },
      "authored-by",
    )).toBe(false);
  });

  it("matches canonical string atoms without treating arbitrary author ids as proof", () => {
    expect(integrityAtomMatchesAuthor(
      "authored-by:alice",
      "alice",
      "authored-by",
    )).toBe(true);
    expect(integrityAtomMatchesAuthor(
      "alice",
      "alice",
      "authored-by",
    )).toBe(false);
  });

  it("derives state from the integrity label view", () => {
    expect(authorshipStateForLabel(
      {
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{ kind: "authored-by", subject: "alice" }],
          },
        }],
      },
      "alice",
      "authored-by",
    )).toBe("verified");

    expect(authorshipStateForLabel(
      {
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{ kind: "authored-by", subject: "alice" }],
          },
        }],
      },
      "bob",
      "authored-by",
    )).toBe("unverified");
  });

  it("keeps non-authorship integrity unknown instead of unverified", () => {
    expect(authorshipStateForLabel(
      {
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{
              type: "https://commonfabric.org/cfc/atom/LinkReference",
            }],
          },
        }],
      },
      "alice",
      "authored-by",
    )).toBe("unknown");
  });

  it("does not use child path authorship to certify the root value", () => {
    expect(authorshipStateForLabel(
      {
        version: 1,
        entries: [{
          path: ["author", "id"],
          label: {
            integrity: [{ kind: "authored-by", subject: "alice" }],
          },
        }],
      },
      "alice",
      "authored-by",
    )).toBe("unknown");
  });
});

describe("CFCFCAuthorship disposal handling", () => {
  // refreshLabel is fired as `void this.refreshLabel()`; on a disposal race its
  // readLabelView IPC rejects with AbortError, which must be swallowed rather
  // than left as an unhandled rejection.

  it("does not leak an unhandled rejection when the label read is cancelled", async () => {
    const element = new CFCFCAuthorship();
    element.value = {
      getCfcLabel: () =>
        Promise.reject(new DOMException("aborted", "AbortError")),
    };
    // Resolves (does not reject) — the disposal-raced read is swallowed.
    await element.refreshLabel();
    // The label was left untouched.
    expect(element.cfcLabel).toBeUndefined();
  });

  it("applies the label when the read succeeds", async () => {
    const label = {
      version: 1,
      entries: [{ path: [], label: { integrity: ["x"] } }],
    };
    const element = new CFCFCAuthorship();
    element.value = { getCfcLabel: () => Promise.resolve(label) };
    await element.refreshLabel();
    expect(element.cfcLabel).toEqual(label);
  });
});
