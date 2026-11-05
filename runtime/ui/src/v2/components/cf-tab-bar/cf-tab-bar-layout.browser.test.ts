import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import "./index.ts";
import "../cf-screen/index.ts";

type UpdatingElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

async function settleLayout(root: ParentNode): Promise<void> {
  const elements = Array.from(
    root.querySelectorAll("cf-screen, cf-tab-bar, cf-tab-bar-item"),
  ) as UpdatingElement[];

  await Promise.all(elements.map((element) => element.updateComplete));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.all(elements.map((element) => element.updateComplete));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

Deno.test("cf-tab-bar remains fixed when used standalone", async () => {
  const tabBar = document.createElement("cf-tab-bar");
  tabBar.innerHTML = `
    <cf-tab-bar-item value="home" label="Home"></cf-tab-bar-item>
  `;
  document.body.append(tabBar);

  try {
    await settleLayout(document.body);

    assertEquals(getComputedStyle(tabBar).position, "fixed");
  } finally {
    tabBar.remove();
  }
});

Deno.test("cf-screen reserves space for footer-slotted inset cf-tab-bar", async () => {
  const fixture = document.createElement("div");
  fixture.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 390px",
    "height: 600px",
    "margin: 0",
    "padding: 0",
  ].join(";");
  fixture.innerHTML = `
    <cf-screen
      id="screen"
      style="--cf-tab-bar-height: 64px; --cf-tab-bar-inset-margin: 16px;"
    >
      <div id="content" style="height: 1000px; flex: 0 0 auto;">
        Main content
      </div>
      <cf-tab-bar
        id="tab-bar"
        slot="footer"
        variant="inset"
        position="bottom"
      >
        <cf-tab-bar-item value="home" label="Home"></cf-tab-bar-item>
        <cf-tab-bar-item value="search" label="Search"></cf-tab-bar-item>
        <cf-tab-bar-item value="inbox" label="Inbox"></cf-tab-bar-item>
        <cf-tab-bar-item value="profile" label="Profile"></cf-tab-bar-item>
      </cf-tab-bar>
    </cf-screen>
  `;
  document.body.append(fixture);

  try {
    await settleLayout(fixture);

    const screen = fixture.querySelector("#screen") as HTMLElement;
    const tabBar = fixture.querySelector("#tab-bar") as HTMLElement;
    const main = screen.shadowRoot?.querySelector(".main") as HTMLElement;
    const footer = screen.shadowRoot?.querySelector(".footer") as HTMLElement;
    const container = tabBar.shadowRoot?.querySelector(
      ".container",
    ) as HTMLElement;

    assert(main);
    assert(footer);
    assert(container);
    assertEquals(getComputedStyle(tabBar).position, "relative");

    const mainStyle = getComputedStyle(main);
    const mainMaskImage = mainStyle.maskImage ||
      mainStyle.webkitMaskImage;
    const mainRect = main.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const tabBarRect = tabBar.getBoundingClientRect();
    const fixtureRect = fixture.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    assert(mainMaskImage.includes("linear-gradient"), mainMaskImage);
    assert(
      mainMaskImage.includes("transparent") ||
        /rgba\(0,\s*0,\s*0,\s*0\)/.test(mainMaskImage),
      mainMaskImage,
    );
    assertAlmostEquals(parseFloat(mainStyle.paddingBottom), 64, 0.5);
    assertAlmostEquals(parseFloat(mainStyle.marginBottom), -64, 0.5);
    assertAlmostEquals(tabBarRect.height, 80, 0.5);
    assertAlmostEquals(footerRect.height, 80, 0.5);
    assertAlmostEquals(mainRect.bottom - footerRect.top, 64, 0.5);
    assertAlmostEquals(fixtureRect.bottom - containerRect.bottom, 16, 0.5);
  } finally {
    fixture.remove();
  }
});
