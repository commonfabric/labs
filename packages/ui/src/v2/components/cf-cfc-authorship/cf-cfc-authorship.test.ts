import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

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

  it("retries the resolved cell label until its cold doc loads", async () => {
    // getCfcLabel is a pure, non-blocking store read, so a resolved cell whose
    // doc hasn't loaded yet returns nothing. This component does not subscribe
    // to the internally-resolved cell, so it must poll until the label lands —
    // otherwise a cold linked/bound-prop author stays unverified forever.
    const cfcLabel = {
      version: 1 as const,
      entries: [{
        path: [],
        label: { integrity: [{ kind: "authored-by", subject: "alice" }] },
      }],
    };
    let labelAvailable = false;
    // Open the fake clock up front. The component schedules its retry poll as a
    // real setTimeout in `scheduleLabelRetry()`, which the `refreshLabel()` call
    // below reaches through `reconcileLabelRetry()` — so the timer is armed
    // there, not here. FakeTime only intercepts timers scheduled after it is
    // installed, so it has to be in place before the element runs any of its own
    // code. The `using` declaration restores the real clock when the test ends.
    using time = new FakeTime();
    const element = new CFCFCAuthorship();
    Object.defineProperty(element, "isConnected", {
      value: true,
      configurable: true,
    });

    try {
      element.author = "alice";
      element.value = {
        getCfcLabel: () => Promise.resolve(undefined),
        resolveAsCell: () =>
          Promise.resolve({
            getCfcLabel: () =>
              Promise.resolve(labelAvailable ? cfcLabel : undefined),
          }),
      };

      await element.refreshLabel();
      expect(element.authorshipState).not.toBe("verified");

      labelAvailable = true;
      // Advance the clock. runAllAsync() is the actual advance: it jumps logical
      // time to the one pending retry timer and fires it, so the test never
      // hardcodes the poll interval. Firing the retry starts an async re-read of
      // the now-loaded resolved label (getCfcLabel resolves through microtasks).
      // runAllAsync drains microtasks before each timer it fires, not after the
      // last one, so runMicrotasks() flushes that trailing re-read to completion.
      // runMicrotasks() does not move the clock.
      await time.runAllAsync();
      await time.runMicrotasks();

      expect(element.authorshipState).toBe("verified");
    } finally {
      element.disconnectedCallback();
    }
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
  function authorshipThis(getCfcLabel: () => Promise<unknown>): {
    value: unknown;
    kind: undefined;
    _labelRequestId: number;
    cfcLabel: unknown;
    _valueResolutionPending: boolean;
    requestUpdate: () => void;
    reconcileLabelRetry: () => void;
  } {
    return {
      value: { getCfcLabel },
      kind: undefined,
      _labelRequestId: 0,
      cfcLabel: undefined,
      _valueResolutionPending: false,
      requestUpdate: () => {},
      reconcileLabelRetry: () => {},
    };
  }

  function refreshLabel(fakeThis: unknown): Promise<void> {
    return (CFCFCAuthorship.prototype as unknown as {
      refreshLabel(this: unknown): Promise<void>;
    }).refreshLabel.call(fakeThis);
  }

  it("does not leak an unhandled rejection when the label read is cancelled", async () => {
    const fakeThis = authorshipThis(() =>
      Promise.reject(new DOMException("aborted", "AbortError"))
    );
    // Resolves (does not reject) — the fix swallows the disposal-raced read.
    await refreshLabel(fakeThis);
    // The label was left untouched.
    expect(fakeThis.cfcLabel).toBeUndefined();
  });

  it("applies the label when the read succeeds", async () => {
    const label = {
      version: 1,
      entries: [{ path: [], label: { integrity: ["x"] } }],
    };
    const fakeThis = authorshipThis(() => Promise.resolve(label));
    await refreshLabel(fakeThis);
    expect(fakeThis.cfcLabel).toEqual(label);
  });
});
