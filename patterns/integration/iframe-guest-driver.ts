/**
 * Drives a `cf-iframe` guest's document from a browser integration test, for
 * a test that acts on the guest's own controls.
 */

import { type Page, waitForCondition } from "@commonfabric/integration";

const GUEST_WAIT_BACKSTOP_MS = 5 * 60 * 1_000;

type CdpResult = Record<string, unknown>;

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

/**
 * Drives the document of one sandboxed iframe guest through a second CDP
 * client. The guest is an opaque-origin frame the shell document cannot reach,
 * so the driver creates an isolated world in the real guest frame and acts on
 * the guest's ordinary controls there.
 */
export class GuestDomDriver {
  readonly #socket: WebSocket;
  readonly #sessionId: string;
  readonly #contextId: number;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: CdpResult) => void;
      reject: (error: Error) => void;
    }
  >();

  private constructor(
    socket: WebSocket,
    sessionId: string,
    contextId: number,
  ) {
    this.#socket = socket;
    this.#sessionId = sessionId;
    this.#contextId = contextId;
  }

  /**
   * Connects to the browser at `browserEndpoint` and finds the guest frame
   * whose document holds an element matching `guestSelector`.
   */
  static async connect(
    browserEndpoint: string,
    guestSelector: string,
  ): Promise<GuestDomDriver> {
    const socket = new WebSocket(browserEndpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to browser CDP.")),
        { once: true },
      );
    });
    const bootstrap = new GuestDomDriver(socket, "", 0);
    socket.addEventListener("message", (event) => bootstrap.#onMessage(event));
    socket.addEventListener("close", () => {
      bootstrap.#rejectPending("Browser CDP connection closed.");
    });

    // A failed discovery closes the socket, as a finished driver's close()
    // does, so no CDP connection outlives the test that opened it.
    try {
      const { targetInfos } = await bootstrap.#send("Target.getTargets") as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      };
      const candidates = targetInfos.filter((target) =>
        target.type === "page" || target.type === "iframe"
      );
      const inspected: string[] = [];
      for (const target of candidates) {
        const { sessionId } = await bootstrap.#send(
          "Target.attachToTarget",
          { targetId: target.targetId, flatten: true },
        ) as { sessionId: string };
        const { frameTree } = await bootstrap.#send(
          "Page.getFrameTree",
          {},
          sessionId,
        ) as { frameTree: FrameTree };
        for (const frameId of GuestDomDriver.#frameIds(frameTree)) {
          try {
            const { executionContextId } = await bootstrap.#send(
              "Page.createIsolatedWorld",
              {
                frameId,
                worldName: `iframe-guest-driver-${crypto.randomUUID()}`,
              },
              sessionId,
            ) as { executionContextId: number };
            const value = await bootstrap.#evaluateIn(
              sessionId,
              executionContextId,
              `Boolean(document.querySelector(${
                JSON.stringify(guestSelector)
              }))`,
            );
            if (value === true) {
              return new GuestDomDriver(socket, sessionId, executionContextId)
                .#adopt(bootstrap);
            }
          } catch (error) {
            inspected.push(
              `${target.type}:${target.url}:${frameId}:` +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        inspected.push(`${target.type}:${target.url}`);
      }
      throw new Error(
        `Could not find a guest frame holding ${guestSelector}. Inspected ${
          inspected.join(" | ")
        }`,
      );
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  #adopt(bootstrap: GuestDomDriver): GuestDomDriver {
    this.#nextId = bootstrap.#nextId;
    this.#pending = bootstrap.#pending;
    return this;
  }

  static *#frameIds(tree: FrameTree): Generator<string> {
    yield tree.frame.id;
    for (const child of tree.childFrames ?? []) {
      yield* GuestDomDriver.#frameIds(child);
    }
  }

  #onMessage(event: MessageEvent): void {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: CdpResult;
      error?: { message: string };
    };
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result ?? {});
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpResult> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser CDP connection is not open."));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async #evaluateIn(
    sessionId: string,
    contextId: number,
    expression: string,
  ): Promise<unknown> {
    const response = await this.#send(
      "Runtime.evaluate",
      {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    ) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ?? "Guest evaluation failed.",
      );
    }
    return response.result?.value;
  }

  async evaluate<T>(expression: string): Promise<T> {
    return await this.#evaluateIn(
      this.#sessionId,
      this.#contextId,
      expression,
    ) as T;
  }

  async waitFor<T>(reader: string): Promise<T> {
    return await this.evaluate<T>(`new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        observer.disconnect();
        clearTimeout(backstop);
        callback(value);
      };
      const check = () => {
        try {
          const value = (${reader})();
          if (value === false || value === null || value === undefined) return;
          finish(resolve, value);
        } catch (error) {
          finish(reject, error);
        }
      };
      const observer = new MutationObserver(() => check());
      const backstop = setTimeout(() => {
        finish(
          reject,
          new Error('Guest condition did not settle before the test backstop.'),
        );
      }, ${GUEST_WAIT_BACKSTOP_MS});
      observer.observe(document, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      check();
    })`);
  }

  async click(selector: string): Promise<void> {
    await this.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLElement)) {
        throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      }
      if ('disabled' in control && control.disabled) {
        throw new Error('Disabled control: ' + ${JSON.stringify(selector)});
      }
      control.click();
      return true;
    })()`);
  }

  async setValue(selector: string, value: string): Promise<void> {
    await this.evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(selector)});
      if (!(control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement)) {
        throw new Error('Missing editable control: ' + ${
      JSON.stringify(selector)
    });
      }
      control.value = ${JSON.stringify(value)};
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  close(): void {
    this.#rejectPending("Guest DOM driver closed.");
    this.#socket.close();
  }
}

/** Resolves once the page's sandboxed guest frame has loaded. */
export async function waitForGuestFrame(page: Page): Promise<void> {
  await waitForCondition(
    page,
    (probe) =>
      probe.collect("common-iframe-sandbox").some((candidate) =>
        candidate.getAttribute("load-state") === "loaded"
      ),
  );
}
