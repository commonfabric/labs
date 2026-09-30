import { assert, assertAlmostEquals, assertLessOrEqual } from "@std/assert";
import { expect } from "@std/expect";
import { CFButton } from "../cf-button/index.ts";
import { CFInput } from "../cf-input/index.ts";
import "./index.ts";

type UpdatingModal = HTMLElement & {
  open: boolean;
  preventScroll: boolean;
  updateComplete: Promise<unknown>;
};

type ModalVariant = {
  name: string;
  attributes: Record<string, string>;
  viewportMaxHeight: (viewportHeight: number) => number;
};

type MountedModal = {
  fixture: HTMLElement;
  modalContainer: HTMLElement;
  dialog: HTMLElement;
  content: HTMLElement;
  footerButton: HTMLElement;
};

const VARIANTS: ModalVariant[] = [
  {
    name: "dialog",
    attributes: {},
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.9,
  },
  {
    name: "full-size dialog",
    attributes: { size: "full" },
    viewportMaxHeight: (viewportHeight) => viewportHeight - 32,
  },
  {
    name: "automatic sheet",
    attributes: { presentation: "sheet" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.9,
  },
  {
    name: "half sheet",
    attributes: { presentation: "sheet", detent: "half" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.5,
  },
  {
    name: "full sheet",
    attributes: { presentation: "sheet", detent: "full" },
    viewportMaxHeight: (viewportHeight) => viewportHeight * 0.92,
  },
];

async function settleLayout(element: UpdatingModal): Promise<void> {
  await element.updateComplete;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await element.updateComplete;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function requiredElement(
  root: ParentNode,
  selector: string,
): HTMLElement {
  const element = root.querySelector(selector);
  assert(
    element instanceof HTMLElement,
    `Expected ${selector} to be an HTMLElement`,
  );
  return element;
}

async function mountModal(
  variant: ModalVariant,
  fixtureHeight: string,
  customMaxHeight?: string,
): Promise<MountedModal> {
  const fixture = document.createElement("div");
  fixture.style.cssText = [
    "position: fixed",
    "inset: 24px auto auto 24px",
    "width: 640px",
    `height: ${fixtureHeight}`,
    "transform: translateZ(0)",
    "overflow: hidden",
  ].join(";");
  document.body.append(fixture);

  try {
    const modal = document.createElement("cf-modal") as UpdatingModal;
    modal.open = true;
    modal.preventScroll = false;
    modal.style.setProperty("--cf-modal-animation-duration", "0ms");
    modal.style.setProperty("--cf-modal-border", "4px solid transparent");
    if (customMaxHeight) {
      modal.style.setProperty("--cf-modal-max-height", customMaxHeight);
    }
    for (const [name, value] of Object.entries(variant.attributes)) {
      modal.setAttribute(name, value);
    }
    modal.innerHTML = `
      <span slot="header">Review command</span>
      <div style="height: 10000px">Command data</div>
      <button slot="footer" type="button">Send command</button>
    `;
    fixture.append(modal);
    await settleLayout(modal);

    const shadowRoot = modal.shadowRoot;
    assert(shadowRoot);
    return {
      fixture,
      modalContainer: requiredElement(shadowRoot, ".container"),
      dialog: requiredElement(shadowRoot, ".dialog"),
      content: requiredElement(shadowRoot, ".content"),
      footerButton: requiredElement(modal, '[slot="footer"]'),
    };
  } catch (error) {
    fixture.remove();
    throw error;
  }
}

function assertContained(
  variant: ModalVariant,
  mounted: MountedModal,
): void {
  const fixtureRect = mounted.fixture.getBoundingClientRect();
  const containerRect = mounted.modalContainer.getBoundingClientRect();
  const dialogRect = mounted.dialog.getBoundingClientRect();
  const footerButtonRect = mounted.footerButton.getBoundingClientRect();
  const containerStyle = getComputedStyle(mounted.modalContainer);
  const contentTop = containerRect.top +
    Number.parseFloat(containerStyle.paddingTop);
  const contentBottom = containerRect.bottom -
    Number.parseFloat(containerStyle.paddingBottom);
  const contentLeft = containerRect.left +
    Number.parseFloat(containerStyle.paddingLeft);
  const contentRight = containerRect.right -
    Number.parseFloat(containerStyle.paddingRight);

  assertAlmostEquals(containerRect.top, fixtureRect.top, 0.5);
  assertAlmostEquals(containerRect.bottom, fixtureRect.bottom, 0.5);
  assertAlmostEquals(containerRect.left, fixtureRect.left, 0.5);
  assertAlmostEquals(containerRect.right, fixtureRect.right, 0.5);
  assert(
    dialogRect.left >= contentLeft - 0.5,
    `${variant.name}: dialog left ${dialogRect.left}, ` +
      `content left ${contentLeft}`,
  );
  assertLessOrEqual(
    dialogRect.right,
    contentRight + 0.5,
    `${variant.name}: dialog right ${dialogRect.right}, ` +
      `content right ${contentRight}`,
  );
  assert(
    dialogRect.top >= contentTop - 0.5,
    `${variant.name}: dialog top ${dialogRect.top}, content top ${contentTop}`,
  );
  assertLessOrEqual(
    dialogRect.bottom,
    contentBottom + 0.5,
    `${variant.name}: dialog bottom ${dialogRect.bottom}, ` +
      `content bottom ${contentBottom}`,
  );
  if (variant.attributes.presentation === "sheet") {
    assertAlmostEquals(dialogRect.left, contentLeft, 0.5);
    assertAlmostEquals(dialogRect.right, contentRight, 0.5);
  }
  assert(
    footerButtonRect.width > 0 && footerButtonRect.height > 0,
    `${variant.name}: footer control should be visible`,
  );
  assert(
    footerButtonRect.left >= dialogRect.left - 0.5,
    `${variant.name}: footer control left ${footerButtonRect.left}, ` +
      `dialog left ${dialogRect.left}`,
  );
  assertLessOrEqual(
    footerButtonRect.right,
    dialogRect.right + 0.5,
    `${variant.name}: footer control right ${footerButtonRect.right}, ` +
      `dialog right ${dialogRect.right}`,
  );
  assert(
    footerButtonRect.top >= dialogRect.top - 0.5,
    `${variant.name}: footer control top ${footerButtonRect.top}, ` +
      `dialog top ${dialogRect.top}`,
  );
  assertLessOrEqual(
    footerButtonRect.bottom,
    dialogRect.bottom + 0.5,
    `${variant.name}: footer control bottom ${footerButtonRect.bottom}, ` +
      `dialog bottom ${dialogRect.bottom}`,
  );
  assert(
    mounted.content.scrollHeight > mounted.content.clientHeight,
    `${variant.name}: content should scroll inside the dialog`,
  );
}

for (const variant of VARIANTS) {
  Deno.test(`${variant.name} stays inside its fixed-position containing block`, async () => {
    const mounted = await mountModal(variant, "320px");
    try {
      assertContained(variant, mounted);
    } finally {
      mounted.fixture.remove();
    }
  });

  Deno.test(`${variant.name} preserves its viewport height limit`, async () => {
    const mounted = await mountModal(variant, "200vh");
    try {
      const dialogHeight = mounted.dialog.getBoundingClientRect().height;
      const expectedHeight = variant.viewportMaxHeight(innerHeight);
      assertAlmostEquals(
        dialogHeight,
        expectedHeight,
        0.5,
        `${variant.name}: height ${dialogHeight}, expected ${expectedHeight}`,
      );
      assert(
        mounted.content.scrollHeight > mounted.content.clientHeight,
        `${variant.name}: content should reach the height limit`,
      );
    } finally {
      mounted.fixture.remove();
    }
  });
}

Deno.test("dialog preserves a custom maximum height", async () => {
  const mounted = await mountModal(VARIANTS[0], "320px", "180px");
  try {
    assertAlmostEquals(
      mounted.dialog.getBoundingClientRect().height,
      180,
      0.5,
    );
    assertContained(VARIANTS[0], mounted);
  } finally {
    mounted.fixture.remove();
  }
});

/** Creates the shadow boundary used by an embedded pattern renderer. */
async function mountKeyboardModal() {
  const fixture = document.createElement("div");
  const root = fixture.attachShadow({ mode: "open" });
  const opener = document.createElement("cf-input") as CFInput;
  const modal = document.createElement("cf-modal") as UpdatingModal;
  modal.preventScroll = false;
  modal.style.setProperty("--cf-modal-animation-duration", "0ms");
  const heading = document.createElement("span");
  heading.slot = "header";
  heading.textContent = "Your name";
  const field = document.createElement("cf-input") as CFInput;
  const done = document.createElement("cf-button") as CFButton;
  expect(opener).toBeInstanceOf(CFInput);
  expect(field).toBeInstanceOf(CFInput);
  expect(done).toBeInstanceOf(CFButton);
  done.slot = "footer";
  done.textContent = "Done";
  modal.append(heading, field, done);
  root.append(opener, modal);
  document.body.append(fixture);
  await Promise.all([
    opener.updateComplete,
    modal.updateComplete,
    field.updateComplete,
    done.updateComplete,
  ]);
  modal.addEventListener("cf-modal-close", () => {
    modal.open = false;
  });
  return { fixture, root, opener, modal, field, done };
}

/** Dispatches the composed keyboard event that reaches a modal's focus trap. */
function tabFrom(
  element: HTMLElement | SVGElement,
  shiftKey = false,
): KeyboardEvent {
  element.focus();
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  element.dispatchEvent(event);
  return event;
}

Deno.test("dialog wraps focus inside a renderer shadow root", async () => {
  const mounted = await mountKeyboardModal();
  try {
    mounted.modal.open = true;
    await settleLayout(mounted.modal);
    const close = requiredElement(mounted.modal.shadowRoot!, ".close-button");
    expect(tabFrom(mounted.done).defaultPrevented).toBe(true);
    expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
    expect(tabFrom(close, true).defaultPrevented).toBe(true);
    expect(mounted.root.activeElement).toBe(mounted.done);
  } finally {
    mounted.fixture.remove();
  }
});

Deno.test("dialog restores the original control inside nested shadow roots", async () => {
  const mounted = await mountKeyboardModal();
  try {
    mounted.opener.focus();
    const input = requiredElement(mounted.opener.shadowRoot!, "input");
    expect(mounted.opener.shadowRoot!.activeElement).toBe(input);
    mounted.modal.open = true;
    await settleLayout(mounted.modal);
    const close = requiredElement(mounted.modal.shadowRoot!, ".close-button");
    close.focus();
    expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
    close.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    await mounted.modal.updateComplete;
    expect(mounted.modal.open).toBe(false);
    expect(mounted.root.activeElement).toBe(mounted.opener);
    expect(mounted.opener.shadowRoot!.activeElement).toBe(input);
  } finally {
    mounted.fixture.remove();
  }
});

Deno.test("dialog follows slotted shadow controls and excludes unavailable tab stops", async () => {
  const mounted = await mountKeyboardModal();
  try {
    mounted.done.remove();
    const nested = document.createElement("div");
    nested.slot = "footer";
    const shadow = nested.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <input aria-label="Last field">
      <button disabled>Disabled</button>
      <button tabindex="-1">Programmatic focus only</button>
      <button hidden>Hidden</button>
      <div inert><button>Inert</button></div>
      <div style="visibility: hidden"><button>Invisible</button></div>
    `;
    mounted.modal.append(nested);
    mounted.modal.open = true;
    await settleLayout(mounted.modal);
    const close = requiredElement(mounted.modal.shadowRoot!, ".close-button");
    const last = requiredElement(shadow, "input");
    expect(tabFrom(close, true).defaultPrevented).toBe(true);
    expect(shadow.activeElement).toBe(last);
    expect(tabFrom(last).defaultPrevented).toBe(true);
    expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
  } finally {
    mounted.fixture.remove();
  }
});

/** Builds a natively tabbable SVG link with visible geometry. */
function svgLink() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100");
  svg.setAttribute("height", "30");
  const link = document.createElementNS("http://www.w3.org/2000/svg", "a");
  link.setAttribute("href", "#profile");
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("y", "20");
  text.textContent = "Profile";
  link.append(text);
  svg.append(link);
  return { svg, link };
}

Deno.test("dialog wraps focus from a slotted SVG link", async () => {
  const mounted = await mountKeyboardModal();
  try {
    mounted.done.remove();
    const { svg, link } = svgLink();
    svg.slot = "footer";
    mounted.modal.append(svg);
    mounted.modal.open = true;
    await settleLayout(mounted.modal);
    const close = requiredElement(mounted.modal.shadowRoot!, ".close-button");
    expect(tabFrom(close, true).defaultPrevented).toBe(true);
    expect(mounted.root.activeElement).toBe(link);
    expect(tabFrom(link).defaultPrevented).toBe(true);
    expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
  } finally {
    mounted.fixture.remove();
  }
});

Deno.test("dialog restores focus to an SVG opener inside a shadow root", async () => {
  const mounted = await mountKeyboardModal();
  try {
    const { svg, link } = svgLink();
    mounted.root.prepend(svg);
    link.focus();
    expect(mounted.root.activeElement).toBe(link);
    mounted.modal.open = true;
    await settleLayout(mounted.modal);
    const close = requiredElement(mounted.modal.shadowRoot!, ".close-button");
    close.focus();
    expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
    mounted.modal.open = false;
    await mounted.modal.updateComplete;
    expect(mounted.root.activeElement).toBe(link);
  } finally {
    mounted.fixture.remove();
  }
});

for (const outsideLink of [false, true]) {
  Deno.test(
    outsideLink
      ? "dialog includes native links outside a disabled fieldset legend"
      : "dialog includes the enabled first legend of a disabled fieldset",
    async () => {
      const mounted = await mountKeyboardModal();
      try {
        mounted.done.remove();
        const fieldset = document.createElement("fieldset");
        fieldset.slot = "footer";
        fieldset.disabled = true;
        fieldset.innerHTML = `
          <legend>
            <button id="legend-enabled">Enable settings</button>
            <button id="legend-disabled" disabled>Disabled legend action</button>
          </legend>
          <input id="body-disabled" aria-label="Disabled settings">
          <legend><button id="later-disabled">Later legend</button></legend>
        `;
        const anchor = document.createElement("a");
        anchor.href = "#settings-help";
        anchor.textContent = "Settings help";
        if (outsideLink) fieldset.append(anchor);
        mounted.modal.append(fieldset);
        mounted.modal.open = true;
        await settleLayout(mounted.modal);
        const close = requiredElement(
          mounted.modal.shadowRoot!,
          ".close-button",
        );
        const enabled = requiredElement(fieldset, "#legend-enabled");
        expect(enabled.matches(":disabled")).toBe(false);
        enabled.focus();
        expect(mounted.root.activeElement).toBe(enabled);
        const last = outsideLink ? anchor : enabled;
        expect(last.matches(":disabled")).toBe(false);
        last.focus();
        expect(mounted.root.activeElement).toBe(last);
        for (
          const id of ["legend-disabled", "body-disabled", "later-disabled"]
        ) {
          const disabled = requiredElement(fieldset, `#${id}`);
          expect(disabled.matches(":disabled")).toBe(true);
          disabled.focus();
          expect(mounted.root.activeElement).toBe(last);
        }
        expect(tabFrom(close, true).defaultPrevented).toBe(true);
        expect(mounted.root.activeElement).toBe(last);
        expect(tabFrom(last).defaultPrevented).toBe(true);
        expect(mounted.modal.shadowRoot!.activeElement).toBe(close);
      } finally {
        mounted.fixture.remove();
      }
    },
  );
}
