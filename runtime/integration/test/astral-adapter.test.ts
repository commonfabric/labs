import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { Browser } from "../browser.ts";
import { Page } from "../page.ts";

async function closeTestBrowser(
  page: Page,
  browser: Browser,
): Promise<void> {
  let closeError: unknown;
  try {
    await page.close();
  } catch (error) {
    closeError = error;
  }
  try {
    await browser.close();
  } catch (error) {
    closeError ??= error;
  }
  if (closeError !== undefined) throw closeError;
}

async function armSelectorStateInstallation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const owner = globalThis as typeof globalThis & {
      __commonToolsSelectorStateInstalled?: Promise<void>;
    };
    let selectorState: unknown;
    owner.__commonToolsSelectorStateInstalled = new Promise((resolve) => {
      Object.defineProperty(
        globalThis,
        Symbol.for("common-tools.astral.selector-waits"),
        {
          configurable: true,
          get: () => selectorState,
          set: (value) => {
            selectorState = value;
            resolve();
          },
        },
      );
    });
  });
}

async function waitForSelectorStateInstallation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const owner = globalThis as typeof globalThis & {
      __commonToolsSelectorStateInstalled: Promise<void>;
    };
    return owner.__commonToolsSelectorStateInstalled;
  });
}

Deno.test("Browser closes a published Astral browser", async () => {
  const browser = await Browser.launch();
  await browser.close();
});

Deno.test("pierce waits reject when their page closes", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    const target = page.waitForSelector("#never-created", {
      strategy: "pierce",
    });
    const rejected = assertRejects(
      () => target,
      Error,
      "Astral page connection closed",
    );
    await page.close();
    await rejected;
  } finally {
    await browser.close();
  }
});

Deno.test("ElementHandle pierce waits observe their own shadow root", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      host.id = "scoped-shadow-host";
      host.attachShadow({ mode: "open" });

      const lightTarget = document.createElement("button");
      lightTarget.id = "scoped-light-target";
      lightTarget.className = "scoped-light";
      host.append(lightTarget);
      document.body.append(host);
    });

    const host = await page.waitForSelector("#scoped-shadow-host");
    await armSelectorStateInstallation(page);
    const target = host.waitForSelector(".scoped-target", {
      strategy: "pierce",
    });
    await waitForSelectorStateInstallation(page);

    await page.evaluate(() => {
      const shadowTarget = document.createElement("button");
      shadowTarget.id = "scoped-shadow-target";
      shadowTarget.className = "scoped-target";
      document
        .getElementById("scoped-shadow-host")!
        .shadowRoot!
        .append(shadowTarget);
    });

    assertEquals(
      await (await target).getAttribute("id"),
      "scoped-shadow-target",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("pierce selectors resolve light-DOM elements", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const lightTarget = document.createElement("button");
      lightTarget.className = "pierce-target";
      lightTarget.textContent = "light";
      document.body.append(lightTarget);

      const host = document.createElement("section");
      host.id = "pierce-shadow-host";
      const root = host.attachShadow({ mode: "open" });
      const shadowTarget = document.createElement("button");
      shadowTarget.className = "pierce-target";
      shadowTarget.textContent = "shadow";
      root.append(shadowTarget);
      document.body.append(host);

      const scope = document.createElement("main");
      scope.id = "pierce-scope";
      document.body.append(scope);
    });

    const firstTarget = await page.$(".pierce-target", { strategy: "pierce" });
    assertEquals(await firstTarget?.innerText(), "light");

    const targets = await page.$$(".pierce-target", { strategy: "pierce" });
    assertEquals(
      await Promise.all(targets.map((target) => target.innerText())),
      ["light", "shadow"],
    );

    const awaitedTarget = await page.waitForSelector(".pierce-target", {
      strategy: "pierce",
    });
    assertEquals(await awaitedTarget.innerText(), "light");

    const host = await page.waitForSelector("#pierce-shadow-host");
    const hostTarget = await host.$(".pierce-target", { strategy: "pierce" });
    assertEquals(await hostTarget?.innerText(), "shadow");

    const lateTarget = page.waitForSelector("#late-light-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "late-light-target";
      target.textContent = "late light";
      document.body.append(target);
    });
    assertEquals(await (await lateTarget).innerText(), "late light");

    const scope = await page.waitForSelector("#pierce-scope");
    const scopedTarget = scope.waitForSelector("#scoped-late-light-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "scoped-late-light-target";
      target.textContent = "scoped late light";
      document.getElementById("pierce-scope")!.append(target);
    });
    assertEquals(await (await scopedTarget).innerText(), "scoped late light");
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers use writable locked descriptors", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("input");
      target.id = "writable-method-target";
      root.append(target);
      document.body.append(host);

      const methodDescriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "setCustomValidity",
      )!;
      Object.defineProperty(
        HTMLInputElement.prototype,
        "setCustomValidity",
        { ...methodDescriptor, configurable: false },
      );

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalWritableMethod?: typeof target.setCustomValidity;
        __commonToolsWritableMethodStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalWritableMethod = methodDescriptor.value;
      let selectorState: unknown;
      owner.__commonToolsWritableMethodStateInstalled = new Promise(
        (resolve) => {
          Object.defineProperty(
            globalThis,
            Symbol.for("common-tools.astral.selector-waits"),
            {
              configurable: true,
              get: () => selectorState,
              set: (value) => {
                selectorState = value;
                resolve();
              },
            },
          );
        },
      );
    });

    const invalidTarget = page.waitForSelector(
      "#writable-method-target:invalid",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsWritableMethodStateInstalled: Promise<void>;
      };
      return owner.__commonToolsWritableMethodStateInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalWritableMethod:
            typeof HTMLInputElement.prototype.setCustomValidity;
        };
        return HTMLInputElement.prototype.setCustomValidity !==
          owner.__commonToolsOriginalWritableMethod;
      }),
    );
    await page.evaluate(() => {
      const target = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("writable-method-target") as HTMLInputElement;
      target.setCustomValidity("invalid");
    });
    assertEquals(
      await (await invalidTarget).getAttribute("id"),
      "writable-method-target",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers cover submit-button validity", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.id = "invalid-submit";
      button.type = "submit";
      root.append(button);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalButtonValidity?: typeof button.setCustomValidity;
        __commonToolsButtonValidityStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalButtonValidity =
        HTMLButtonElement.prototype.setCustomValidity;
      let selectorState: unknown;
      owner.__commonToolsButtonValidityStateInstalled = new Promise(
        (resolve) => {
          Object.defineProperty(
            globalThis,
            Symbol.for("common-tools.astral.selector-waits"),
            {
              configurable: true,
              get: () => selectorState,
              set: (value) => {
                selectorState = value;
                resolve();
              },
            },
          );
        },
      );
    });

    const invalidButton = page.waitForSelector("#invalid-submit:invalid", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsButtonValidityStateInstalled: Promise<void>;
      };
      return owner.__commonToolsButtonValidityStateInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalButtonValidity:
            typeof HTMLButtonElement.prototype.setCustomValidity;
        };
        return HTMLButtonElement.prototype.setCustomValidity !==
          owner.__commonToolsOriginalButtonValidity;
      }),
    );
    await page.evaluate(() => {
      const button = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("invalid-submit") as HTMLButtonElement;
      button.setCustomValidity("invalid");
    });
    assertEquals(
      await (await invalidButton).getAttribute("id"),
      "invalid-submit",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers cover custom-element validity", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      class ValidityControl extends HTMLElement {
        static formAssociated = true;
        #internals = this.attachInternals();

        setInvalid(): void {
          this.#internals.setValidity(
            { customError: true },
            "invalid",
          );
        }
      }
      customElements.define("validity-control", ValidityControl);

      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const form = document.createElement("form");
      const control = document.createElement("validity-control");
      control.id = "invalid-custom-control";
      form.append(control);
      root.append(form);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalInternalsValidity?:
          typeof ElementInternals.prototype.setValidity;
        __commonToolsInternalsValidityStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalInternalsValidity =
        ElementInternals.prototype.setValidity;
      let selectorState: unknown;
      owner.__commonToolsInternalsValidityStateInstalled = new Promise(
        (resolve) => {
          Object.defineProperty(
            globalThis,
            Symbol.for("common-tools.astral.selector-waits"),
            {
              configurable: true,
              get: () => selectorState,
              set: (value) => {
                selectorState = value;
                resolve();
              },
            },
          );
        },
      );
    });

    const invalidControl = page.waitForSelector(
      "#invalid-custom-control:invalid",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsInternalsValidityStateInstalled: Promise<void>;
      };
      return owner.__commonToolsInternalsValidityStateInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalInternalsValidity:
            typeof ElementInternals.prototype.setValidity;
        };
        return ElementInternals.prototype.setValidity !==
          owner.__commonToolsOriginalInternalsValidity;
      }),
    );
    await page.evaluate(() => {
      const control = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("invalid-custom-control") as HTMLElement & {
          setInvalid(): void;
        };
      control.setInvalid();
    });
    assertEquals(
      await (await invalidControl).getAttribute("id"),
      "invalid-custom-control",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers cover custom-element definition", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const control = document.createElement("late-defined-control");
      control.id = "late-defined-control";
      root.append(control);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalCustomElementDefine?:
          typeof CustomElementRegistry.prototype.define;
        __commonToolsCustomElementDefineStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalCustomElementDefine =
        CustomElementRegistry.prototype.define;
      let selectorState: unknown;
      owner.__commonToolsCustomElementDefineStateInstalled = new Promise(
        (resolve) => {
          Object.defineProperty(
            globalThis,
            Symbol.for("common-tools.astral.selector-waits"),
            {
              configurable: true,
              get: () => selectorState,
              set: (value) => {
                selectorState = value;
                resolve();
              },
            },
          );
        },
      );
    });

    const definedControl = page.waitForSelector(
      "#late-defined-control:defined",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsCustomElementDefineStateInstalled: Promise<void>;
      };
      return owner.__commonToolsCustomElementDefineStateInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalCustomElementDefine:
            typeof CustomElementRegistry.prototype.define;
        };
        return CustomElementRegistry.prototype.define !==
          owner.__commonToolsOriginalCustomElementDefine;
      }),
    );
    await page.evaluate(() => {
      customElements.define(
        "late-defined-control",
        class extends HTMLElement {
        },
      );
    });
    assertEquals(
      await (await definedControl).getAttribute("id"),
      "late-defined-control",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers cover custom-element states", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      class StateControl extends HTMLElement {
        #internals = this.attachInternals();

        setReady(): void {
          this.#internals.states.add("ready");
        }
      }
      customElements.define("state-control", StateControl);

      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const control = document.createElement("state-control");
      control.id = "ready-control";
      root.append(control);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalCustomStateAdd?:
          typeof CustomStateSet.prototype.add;
        __commonToolsCustomStateStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalCustomStateAdd = CustomStateSet.prototype.add;
      let selectorState: unknown;
      owner.__commonToolsCustomStateStateInstalled = new Promise((resolve) => {
        Object.defineProperty(
          globalThis,
          Symbol.for("common-tools.astral.selector-waits"),
          {
            configurable: true,
            get: () => selectorState,
            set: (value) => {
              selectorState = value;
              resolve();
            },
          },
        );
      });
    });

    const readyControl = page.waitForSelector(
      "#ready-control:state(ready)",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsCustomStateStateInstalled: Promise<void>;
      };
      return owner.__commonToolsCustomStateStateInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalCustomStateAdd:
            typeof CustomStateSet.prototype.add;
        };
        return CustomStateSet.prototype.add !==
          owner.__commonToolsOriginalCustomStateAdd;
      }),
    );
    await page.evaluate(() => {
      const control = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("ready-control") as HTMLElement & {
          setReady(): void;
        };
      control.setReady();
    });
    assertEquals(
      await (await readyControl).getAttribute("id"),
      "ready-control",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("property observers cover programmatic file selection", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.id = "required-file";
      input.type = "file";
      input.required = true;
      root.append(input);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalFilesSetter?: PropertyDescriptor["set"];
      };
      owner.__commonToolsOriginalFilesSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "files",
      )?.set;
    });
    await armSelectorStateInstallation(page);

    const validFile = page.waitForSelector("#required-file:valid", {
      strategy: "pierce",
    });
    await waitForSelectorStateInstallation(page);
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalFilesSetter?: PropertyDescriptor["set"];
        };
        return Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "files",
        )?.set !== owner.__commonToolsOriginalFilesSetter;
      }),
    );
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["contents"], "selected.txt"));
      const input = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("required-file") as HTMLInputElement;
      input.files = transfer.files;
    });
    assertEquals(
      await (await validFile).getAttribute("id"),
      "required-file",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("root events cover shadow selector state", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const trigger = document.createElement("button");
      trigger.id = "popover-trigger";
      trigger.setAttribute("popovertarget", "selector-popover");
      const popover = document.createElement("div");
      popover.id = "selector-popover";
      popover.popover = "auto";

      const form = document.createElement("form");
      form.id = "selector-form";
      const input = document.createElement("input");
      input.id = "user-invalid-input";
      input.required = true;
      const submit = document.createElement("button");
      submit.type = "submit";
      form.append(input, submit);
      root.append(trigger, popover, form);
      document.body.append(host);

      const eventTypes = new Set<string>();
      const addEventListener = EventTarget.prototype.addEventListener;
      Object.defineProperty(root, "addEventListener", {
        value(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) {
          eventTypes.add(type);
          return addEventListener.call(root, type, listener, options);
        },
      });
      const documentEventTypes = new Set<string>();
      Object.defineProperty(document, "addEventListener", {
        configurable: true,
        value(
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions,
        ) {
          documentEventTypes.add(type);
          return addEventListener.call(document, type, listener, options);
        },
      });
      const owner = globalThis as typeof globalThis & {
        __commonToolsDocumentEventTypes?: Set<string>;
        __commonToolsOriginalInputShowPicker?:
          typeof HTMLInputElement.prototype.showPicker;
        __commonToolsOriginalPushState?: typeof History.prototype.pushState;
        __commonToolsRootEventTypes?: Set<string>;
      };
      owner.__commonToolsDocumentEventTypes = documentEventTypes;
      owner.__commonToolsOriginalInputShowPicker =
        HTMLInputElement.prototype.showPicker;
      owner.__commonToolsOriginalPushState = History.prototype.pushState;
      owner.__commonToolsRootEventTypes = eventTypes;
    });
    await armSelectorStateInstallation(page);

    const openPopover = page.waitForSelector(
      "#selector-popover:popover-open",
      { strategy: "pierce" },
    );
    await waitForSelectorStateInstallation(page);
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsDocumentEventTypes: Set<string>;
          __commonToolsOriginalInputShowPicker:
            typeof HTMLInputElement.prototype.showPicker;
          __commonToolsOriginalPushState: typeof History.prototype.pushState;
          __commonToolsRootEventTypes: Set<string>;
        };
        return [
          "click",
          "enterpictureinpicture",
          "invalid",
          "keydown",
          "keyup",
          "leavepictureinpicture",
          "play",
          "reset",
          "submit",
          "toggle",
        ].every((type) => owner.__commonToolsRootEventTypes.has(type)) &&
          owner.__commonToolsDocumentEventTypes.has("fullscreenchange") &&
          HTMLInputElement.prototype.showPicker !==
            owner.__commonToolsOriginalInputShowPicker &&
          History.prototype.pushState !==
            owner.__commonToolsOriginalPushState;
      }),
    );
    await page.evaluate(() => {
      document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("popover-trigger")!
        .click();
    });
    assertEquals(
      await (await openPopover).getAttribute("id"),
      "selector-popover",
    );

    await armSelectorStateInstallation(page);
    const userInvalidInput = page.waitForSelector(
      "#user-invalid-input:user-invalid",
      { strategy: "pierce" },
    );
    await waitForSelectorStateInstallation(page);
    await page.evaluate(() => {
      const form = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("selector-form") as HTMLFormElement;
      form.requestSubmit();
    });
    assertEquals(
      await (await userInvalidInput).getAttribute("id"),
      "user-invalid-input",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("method observers cover explicit custom-element upgrades", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("main");
      host.attachShadow({ mode: "open" });
      document.body.append(host);

      const detachedRoot = document.createElement("div");
      const control = document.createElement("explicit-upgrade-control");
      control.id = "explicit-upgrade-control";
      detachedRoot.append(control);
      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalUpgrade?:
          typeof CustomElementRegistry.prototype.upgrade;
        __commonToolsUpgradeRoot?: Element;
      };
      owner.__commonToolsOriginalUpgrade =
        CustomElementRegistry.prototype.upgrade;
      owner.__commonToolsUpgradeRoot = detachedRoot;
      customElements.define(
        "explicit-upgrade-control",
        class extends HTMLElement {},
      );
    });
    await armSelectorStateInstallation(page);

    const finishTarget = page.waitForSelector(
      "#explicit-upgrade-finish",
      { strategy: "pierce" },
    );
    await waitForSelectorStateInstallation(page);
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalUpgrade:
            typeof CustomElementRegistry.prototype.upgrade;
        };
        return CustomElementRegistry.prototype.upgrade !==
          owner.__commonToolsOriginalUpgrade;
      }),
    );
    assert(
      await page.evaluate(() => {
        const state = (globalThis as unknown as {
          [key: symbol]: { checks: Set<() => void> };
        })[Symbol.for("common-tools.astral.selector-waits")];
        let checked = false;
        state.checks.add(() => {
          checked = true;
        });

        const owner = globalThis as typeof globalThis & {
          __commonToolsUpgradeRoot: Element;
        };
        customElements.upgrade(owner.__commonToolsUpgradeRoot);
        const upgraded = owner.__commonToolsUpgradeRoot
          .querySelector("#explicit-upgrade-control")!
          .matches(":defined");

        const finish = document.createElement("div");
        finish.id = "explicit-upgrade-finish";
        document.querySelector("main")!.shadowRoot!.append(finish);
        return checked && upgraded;
      }),
    );
    assertEquals(
      await (await finishTarget).getAttribute("id"),
      "explicit-upgrade-finish",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("retained selector state reconciles displaced observers", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("input");
      target.id = "locked-state-target";
      target.type = "checkbox";
      root.append(target);
      document.body.append(host);

      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalSetCustomValidity?:
          typeof target.setCustomValidity;
        __commonToolsSelectorStateInstalled?: Promise<void>;
      };
      owner.__commonToolsOriginalSetCustomValidity =
        HTMLInputElement.prototype.setCustomValidity;
      let selectorState: unknown;
      owner.__commonToolsSelectorStateInstalled = new Promise((resolve) => {
        Object.defineProperty(
          globalThis,
          Symbol.for("common-tools.astral.selector-waits"),
          {
            configurable: true,
            get: () => selectorState,
            set: (value) => {
              selectorState = value;
              resolve();
            },
          },
        );
      });
    });

    const checkedTarget = page.waitForSelector(
      "#locked-state-target:checked",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsSelectorStateInstalled: Promise<void>;
      };
      return owner.__commonToolsSelectorStateInstalled;
    });
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsOriginalSetCustomValidity:
          typeof HTMLInputElement.prototype.setCustomValidity;
      };
      HTMLInputElement.prototype.setCustomValidity =
        owner.__commonToolsOriginalSetCustomValidity;
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "checked",
      )!;
      Object.defineProperty(
        HTMLInputElement.prototype,
        "checked",
        { ...descriptor, configurable: false },
      );
      const target = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("locked-state-target") as HTMLInputElement;
      target.checked = true;
    });
    await checkedTarget;

    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalSetCustomValidity:
            typeof HTMLInputElement.prototype.setCustomValidity;
        };
        return HTMLInputElement.prototype.setCustomValidity ===
          owner.__commonToolsOriginalSetCustomValidity;
      }),
    );

    await page.evaluate(() => {
      const state = (globalThis as unknown as {
        [key: symbol]: { checks: Set<() => void> };
      })[Symbol.for("common-tools.astral.selector-waits")];
      const owner = globalThis as typeof globalThis & {
        __commonToolsNextSelectorCheckInstalled?: Promise<void>;
      };
      const originalAdd = state.checks.add;
      owner.__commonToolsNextSelectorCheckInstalled = new Promise((resolve) => {
        Object.defineProperty(state.checks, "add", {
          configurable: true,
          value(this: Set<() => void>, check: () => void) {
            Reflect.deleteProperty(this, "add");
            const result = originalAdd.call(this, check);
            resolve();
            return result;
          },
        });
      });
    });
    const invalidTarget = page.waitForSelector(
      "#locked-state-target:invalid",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsNextSelectorCheckInstalled: Promise<void>;
      };
      return owner.__commonToolsNextSelectorCheckInstalled;
    });
    assert(
      await page.evaluate(() => {
        const owner = globalThis as typeof globalThis & {
          __commonToolsOriginalSetCustomValidity:
            typeof HTMLInputElement.prototype.setCustomValidity;
        };
        return HTMLInputElement.prototype.setCustomValidity !==
          owner.__commonToolsOriginalSetCustomValidity;
      }),
    );
    await page.evaluate(() => {
      const target = document
        .querySelector("section")!
        .shadowRoot!
        .getElementById("locked-state-target") as HTMLInputElement;
      target.setCustomValidity("invalid");
    });
    assertEquals(
      await (await invalidTarget).getAttribute("id"),
      "locked-state-target",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("Page preserves Common Fabric behavior on published Astral", async () => {
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();
  const astralPage = page.astralPage;

  try {
    await page.evaluate(() => {
      const lightTarget = document.createElement("button");
      lightTarget.className = "target";
      lightTarget.textContent = "light";
      document.body.append(lightTarget);

      const outerHost = document.createElement("section");
      const outerRoot = outerHost.attachShadow({ mode: "open" });
      const outerTarget = document.createElement("button");
      outerTarget.className = "target";
      outerTarget.textContent = "outer";
      outerRoot.append(outerTarget);

      const innerHost = document.createElement("article");
      const innerRoot = innerHost.attachShadow({ mode: "open" });
      const innerTarget = document.createElement("button");
      innerTarget.className = "target";
      innerTarget.textContent = "inner";
      innerRoot.append(innerTarget);
      outerRoot.append(innerHost);
      const queryRoot = document.createElement("main");
      queryRoot.id = "query-root";
      queryRoot.append(outerHost);
      document.body.append(queryRoot);
    });

    const nativeTarget = await page.$(".target");
    assertEquals(await nativeTarget?.innerText(), "light");

    const firstPierceTarget = await page.$(".target", {
      strategy: "pierce",
    });
    assertEquals(await firstPierceTarget?.innerText(), "light");

    const pierceTargets = await page.$$(".target", { strategy: "pierce" });
    assertEquals(
      await Promise.all(pierceTargets.map((target) => target.innerText())),
      ["light", "outer", "inner"],
    );

    const queryRoot = await page.waitForSelector("#query-root");
    const nestedShadowTarget = await queryRoot.$(".target", {
      strategy: "pierce",
    });
    assertEquals(await nestedShadowTarget?.innerText(), "outer");

    const nestedLateTarget = queryRoot.waitForSelector("#nested-late-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("button");
      target.id = "nested-late-target";
      target.textContent = "nested late";
      root.append(target);
      document.getElementById("query-root")!.append(host);
    });
    assertEquals(await (await nestedLateTarget).innerText(), "nested late");

    const lateTarget = page.waitForSelector("#late-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const host = document.createElement("section");
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("button");
      target.id = "late-target";
      target.textContent = "late";
      root.append(target);
      document.body.append(host);
    });
    assertEquals(await (await lateTarget).innerText(), "late");

    await page.evaluate(() => {
      const host = document.createElement("section");
      host.id = "late-shadow-host";
      document.body.append(host);
    });
    const attachedTarget = page.waitForSelector("#attached-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const host = document.getElementById("late-shadow-host");
      const root = host!.attachShadow({ mode: "open" });
      const target = document.createElement("button");
      target.id = "attached-target";
      target.textContent = "attached";
      root.append(target);
    });
    assertEquals(await (await attachedTarget).innerText(), "attached");

    await page.evaluate(() => {
      const host = document.createElement("span");
      host.id = "late-nested-shadow-host";
      document
        .querySelector("#query-root > section")!
        .shadowRoot!
        .append(host);
    });
    const lateNestedTarget = page.waitForSelector("#late-nested-target", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      document
        .querySelector("#query-root > section")!
        .shadowRoot!
        .getElementById("late-nested-shadow-host")!
        .attachShadow({ mode: "open" });
    });
    await page.evaluate(() => {
      const target = document.createElement("button");
      target.id = "late-nested-target";
      document
        .querySelector("#query-root > section")!
        .shadowRoot!
        .getElementById("late-nested-shadow-host")!
        .shadowRoot!
        .append(target);
    });
    assertEquals(
      await (await lateNestedTarget).getAttribute("id"),
      "late-nested-target",
    );

    await page.evaluate(() => {
      const host = document.createElement("section");
      host.id = "selector-mutation-host";
      const root = host.attachShadow({ mode: "open" });

      const attributeTarget = document.createElement("button");
      attributeTarget.id = "attribute-target";
      root.append(attributeTarget);

      const stateTarget = document.createElement("input");
      stateTarget.id = "state-target";
      stateTarget.type = "checkbox";
      const stateForm = document.createElement("form");
      stateForm.id = "state-form";
      stateForm.append(stateTarget);
      const resetButton = document.createElement("button");
      resetButton.id = "state-reset";
      resetButton.type = "reset";
      stateForm.append(resetButton);
      root.append(stateForm);

      document.body.append(host);
    });
    const attributeTarget = page.waitForSelector(
      "#attribute-target.selector-ready",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      document
        .getElementById("selector-mutation-host")!
        .shadowRoot!
        .getElementById("attribute-target")!
        .classList.add("selector-ready");
    });
    assertEquals(
      await (await attributeTarget).getAttribute("id"),
      "attribute-target",
    );

    const stateTarget = page.waitForSelector("#state-target:checked", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const target = document
        .getElementById("selector-mutation-host")!
        .shadowRoot!
        .getElementById("state-target") as HTMLInputElement;
      target.checked = true;
    });
    assertEquals(await (await stateTarget).getAttribute("id"), "state-target");

    const resetTarget = page.waitForSelector("#state-target:not(:checked)", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const root = document
        .getElementById("selector-mutation-host")!
        .shadowRoot!;
      (root.getElementById("state-form") as HTMLFormElement).reset();
    });
    assertEquals(await (await resetTarget).getAttribute("id"), "state-target");

    await page.evaluate(() => {
      const target = document
        .getElementById("selector-mutation-host")!
        .shadowRoot!
        .getElementById("state-target") as HTMLInputElement;
      target.checked = true;
    });
    const activatedResetTarget = page.waitForSelector(
      "#state-target:not(:checked)",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      document
        .getElementById("selector-mutation-host")!
        .shadowRoot!
        .getElementById("state-reset")!
        .click();
    });
    assertEquals(
      await (await activatedResetTarget).getAttribute("id"),
      "state-target",
    );

    const invalidTarget = page.waitForSelector("#state-target:invalid", {
      strategy: "pierce",
    });
    await page.evaluate(() => {
      const target = document
        .getElementById("selector-mutation-host")!
        .shadowRoot!
        .getElementById("state-target") as HTMLInputElement;
      target.setCustomValidity("invalid");
    });
    assertEquals(
      await (await invalidTarget).getAttribute("id"),
      "state-target",
    );

    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsNativeAttachShadow?: typeof Element.prototype.attachShadow;
      };
      owner.__commonToolsNativeAttachShadow = Element.prototype.attachShadow;
      const queryRoot = document.createElement("main");
      queryRoot.id = "shadow-patch-query-root";
      for (const id of ["displaced-patch-host", "recovered-patch-host"]) {
        const host = document.createElement("section");
        host.id = id;
        queryRoot.append(host);
      }
      document.body.append(queryRoot);
    });
    const shadowPatchQueryRoot = await page.waitForSelector(
      "#shadow-patch-query-root",
    );
    const displacedPatchTarget = shadowPatchQueryRoot.waitForSelector(
      "#displaced-patch-target",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __commonToolsNativeAttachShadow: typeof Element.prototype.attachShadow;
      };
      Element.prototype.attachShadow = owner.__commonToolsNativeAttachShadow;
      const host = document.getElementById("displaced-patch-host")!;
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("button");
      target.id = "displaced-patch-target";
      root.append(target);
    });
    assertEquals(
      await (await displacedPatchTarget).getAttribute("id"),
      "displaced-patch-target",
    );

    const recoveredPatchTarget = shadowPatchQueryRoot.waitForSelector(
      "#recovered-patch-target",
      { strategy: "pierce" },
    );
    await page.evaluate(() => {
      const host = document.getElementById("recovered-patch-host")!;
      const root = host.attachShadow({ mode: "open" });
      const target = document.createElement("button");
      target.id = "recovered-patch-target";
      root.append(target);
    });
    assertEquals(
      await (await recoveredPatchTarget).getAttribute("id"),
      "recovered-patch-target",
    );
    await page.evaluate(() => {
      delete (globalThis as typeof globalThis & {
        __commonToolsNativeAttachShadow?: typeof Element.prototype.attachShadow;
      }).__commonToolsNativeAttachShadow;
    });

    let keyboardOptions: { delay?: number } | undefined;
    Object.defineProperty(astralPage.keyboard, "type", {
      configurable: true,
      value: (_text: string, options?: { delay?: number }) => {
        keyboardOptions = options;
        return Promise.resolve();
      },
    });
    page.setDefaultTypeDelay(17);

    const interactions: string[] = [];
    const clickPoints: Array<{ x: number; y: number }> = [];
    page.setInteractionObserver({
      beforeClick: (_element, point) => {
        assert(Number.isFinite(point.x));
        assert(Number.isFinite(point.y));
        clickPoints.push(point);
        interactions.push("beforeClick");
      },
      afterClick: () => {
        interactions.push("afterClick");
      },
      beforeType: () => {
        interactions.push("beforeType");
      },
      afterType: () => {
        interactions.push("afterType");
      },
    });

    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "click-target";
      button.textContent = "click";
      // Pinned so the click point is arithmetic on a known rect rather than
      // on wherever the default layout put the control.
      Object.assign(button.style, {
        position: "fixed",
        left: "60px",
        top: "60px",
        width: "100px",
        height: "30px",
        margin: "0",
        padding: "0",
        border: "0",
      });
      button.addEventListener("click", () => {
        document.body.dataset.clicked = "yes";
      });
      document.body.append(button);

      const offsetButton = document.createElement("button");
      offsetButton.id = "offset-click-target";
      offsetButton.textContent = "offset click";
      Object.assign(offsetButton.style, {
        position: "fixed",
        left: "260px",
        top: "90px",
        width: "100px",
        height: "30px",
        margin: "0",
        padding: "7px 11px 13px 17px",
        borderStyle: "solid",
        borderWidth: "3px 5px 9px 11px",
        boxSizing: "content-box",
        transform: "rotate(8deg) scale(1.2)",
        transformOrigin: "13px 9px",
      });
      document.body.append(offsetButton);

      const transformedAncestor = document.createElement("section");
      Object.assign(transformedAncestor.style, {
        position: "fixed",
        left: "430px",
        top: "80px",
        width: "180px",
        height: "120px",
        transform: "rotate(17deg) scale(0.85)",
        transformOrigin: "20px 30px",
      });
      const transformedDescendant = document.createElement("button");
      transformedDescendant.id = "ancestor-transform-click-target";
      Object.assign(transformedDescendant.style, {
        position: "absolute",
        left: "25px",
        top: "35px",
        width: "80px",
        height: "26px",
        margin: "0",
        padding: "5px 7px",
        border: "3px solid",
        boxSizing: "content-box",
      });
      transformedAncestor.append(transformedDescendant);
      document.body.append(transformedAncestor);

      const perspectiveAncestor = document.createElement("section");
      Object.assign(perspectiveAncestor.style, {
        position: "fixed",
        left: "100px",
        top: "250px",
        width: "180px",
        height: "120px",
        perspective: "400px",
        transformStyle: "preserve-3d",
      });
      const threeDimensionalTarget = document.createElement("button");
      threeDimensionalTarget.id = "three-dimensional-click-target";
      Object.assign(threeDimensionalTarget.style, {
        position: "absolute",
        left: "30px",
        top: "30px",
        width: "90px",
        height: "30px",
        margin: "0",
        padding: "4px 9px",
        border: "2px solid",
        boxSizing: "content-box",
        transform: "rotateY(32deg) rotateX(14deg) translateZ(20px)",
        transformOrigin: "15px 10px",
      });
      perspectiveAncestor.append(threeDimensionalTarget);
      document.body.append(perspectiveAncestor);

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      Object.assign(svg.style, {
        position: "fixed",
        left: "360px",
        top: "270px",
        width: "200px",
        height: "120px",
        overflow: "visible",
        transform: "rotate(-11deg)",
        transformOrigin: "20px 15px",
      });
      const svgTarget = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      svgTarget.id = "svg-click-target";
      svgTarget.setAttribute("x", "30");
      svgTarget.setAttribute("y", "20");
      svgTarget.setAttribute("width", "80");
      svgTarget.setAttribute("height", "40");
      svgTarget.setAttribute("fill", "blue");
      svgTarget.setAttribute("stroke", "black");
      svgTarget.setAttribute("stroke-width", "6");
      svg.append(svgTarget);
      document.body.append(svg);

      const input = document.createElement("input");
      input.id = "type-target";
      document.body.append(input);
    });

    const clickTarget = await page.waitForSelector("#click-target");
    await clickTarget.click();
    assertEquals(
      await page.evaluate(() => document.body.dataset.clicked),
      "yes",
    );

    // The click aims at the center of the control's own rect, and an offset
    // aims from its content-box origin. This control has no border or padding,
    // so both points are direct arithmetic on the pinned rect above.
    let mousePoint: { x: number; y: number } | undefined;
    Object.defineProperty(astralPage.mouse, "click", {
      configurable: true,
      value: (x: number, y: number) => {
        mousePoint = { x, y };
        return Promise.resolve();
      },
    });
    await clickTarget.click();
    assertEquals(mousePoint, { x: 110, y: 75 });
    assertEquals(clickPoints[1], { x: 110, y: 75 });

    await clickTarget.click({ offset: { x: 4, y: 6 } });
    assertEquals(mousePoint, { x: 64, y: 66 });
    assertEquals(clickPoints[2], { x: 64, y: 66 });

    // Match published Astral's offset contract: the offset is added to the
    // content quad's top-left point. A stable DOM-agent box model is the
    // compatibility oracle for geometry that includes the element's own 2D
    // transform, a transformed ancestor, a 3D transform, and SVG layout.
    const offsetCases = [
      { selector: "#offset-click-target", offset: { x: 4, y: 6 } },
      {
        selector: "#ancestor-transform-click-target",
        offset: { x: 7, y: 3 },
      },
      {
        selector: "#three-dimensional-click-target",
        offset: { x: 5, y: 8 },
      },
      { selector: "#svg-click-target", offset: { x: 9, y: 4 } },
    ];
    for (const [index, offsetCase] of offsetCases.entries()) {
      const offsetOracle = await page.waitForSelector(offsetCase.selector);
      const offsetModel = await offsetOracle.boxModel();
      assert(offsetModel);
      let contentOrigin = offsetModel.content[0];
      for (const point of offsetModel.content) {
        if (point.x < contentOrigin.x && point.y < contentOrigin.y) {
          contentOrigin = point;
        }
      }

      const offsetTarget = await page.waitForSelector(offsetCase.selector);
      await offsetTarget.click({ offset: offsetCase.offset });
      assert(mousePoint);
      assertAlmostEquals(
        mousePoint.x,
        contentOrigin.x + offsetCase.offset.x,
        0.01,
      );
      assertAlmostEquals(
        mousePoint.y,
        contentOrigin.y + offsetCase.offset.y,
        0.01,
      );
      assertEquals(clickPoints[3 + index], mousePoint);
    }

    const typeTarget = await page.waitForSelector("#type-target");
    await typeTarget.type("text");
    assertEquals(keyboardOptions, { delay: 17 });
    assertEquals(interactions, [
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeClick",
      "afterClick",
      "beforeType",
      "afterType",
    ]);
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("Page clicks the part of an element that lies inside the page", async () => {
  // An element can reach past the edge of the page it is drawn on: a surface
  // positioned towards the right of a narrow viewport, a control wider than the
  // column it sits in. The middle of such an element's box is a point the page
  // does not have, and a trusted click dispatched there is delivered to the
  // browser, lands outside the page, and reaches nothing at all.
  const observed: { x: number; y: number }[] = [];
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();
  page.setInteractionObserver({
    afterClick: (_element, point) =>
      void observed.push({ x: point.x, y: point.y }),
  });

  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.evaluate(() => {
      // Fixed, so the element cannot be brought into the page by scrolling to
      // it: the part of it inside the page is the whole of what a click has to
      // work with. It spans 700 to 1100 in a page 800 wide, so the middle of
      // the whole box is at 900, a hundred columns past the last column the
      // page has.
      const button = document.createElement("button");
      button.id = "clipped-target";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        position: "fixed",
        left: "700px",
        top: "300px",
        width: "400px",
        height: "40px",
      });
      let clicked = 0;
      button.addEventListener("click", () => {
        clicked++;
      });
      document.body.append(button);
      (globalThis as typeof globalThis & {
        __clippedClicks: () => number;
      }).__clippedClicks = () => clicked;
    });

    const target = await page.waitForSelector("#clipped-target");
    await target.click();

    assertEquals(
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __clippedClicks: () => number;
        }).__clippedClicks()
      ),
      1,
      "the click never landed on the part of the element inside the page",
    );
    // The part of the box inside the page spans 700 to 800 across and 300 to
    // 340 down, so the point to click is 750,320.
    assertEquals(observed, [{ x: 750, y: 320 }]);
  } finally {
    await closeTestBrowser(page, browser);
  }
});

Deno.test("Page reports an element with no part of it inside the page", async () => {
  // Every point on the element is outside the page, so there is nowhere to aim
  // that a click can reach. Saying so is the only honest answer: a click
  // dispatched past the edge of the page reaches nothing, and returning from
  // that tells the caller the element was pressed.
  const browser = await Browser.launch({ timeout: 10_000 });
  const page = await browser.newPage();

  try {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.evaluate(() => {
      const button = document.createElement("button");
      button.id = "off-page-target";
      button.textContent = "Continue as guest";
      Object.assign(button.style, {
        position: "fixed",
        left: "900px",
        top: "300px",
        width: "200px",
        height: "40px",
      });
      let clicked = 0;
      button.addEventListener("click", () => {
        clicked++;
      });
      document.body.append(button);
      (globalThis as typeof globalThis & {
        __offPageClicks: () => number;
      }).__offPageClicks = () => clicked;
    });

    const target = await page.waitForSelector("#off-page-target");
    const error = await assertRejects(() => target.click(), Error);
    assertStringIncludes(error.message, "outside the page");
    assertStringIncludes(error.message, "button#off-page-target");
    // The size of the page, so a message that names some other 800 cannot
    // satisfy this.
    assertStringIncludes(error.message, 'page {"width":800,"height":600}');

    assertEquals(
      await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          __offPageClicks: () => number;
        }).__offPageClicks()
      ),
      0,
      "a click reached an element with no part of it inside the page",
    );
  } finally {
    await closeTestBrowser(page, browser);
  }
});
