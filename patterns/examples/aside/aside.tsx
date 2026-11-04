import { NAME, pattern, UI } from "commonfabric";

// note: you may need to zoom in our out in the browser to see the
// content and/or tabs
export default pattern(() => {
  return {
    [NAME]: "Aside",
    [UI]: (
      // cf-screen provides a full-height layout with header/main/footer areas
      <cf-screen>
        {/* Header slot - fixed at top */}
        <div slot="header">
          <h2>Header Section</h2>
        </div>

        {/* cf-autolayout creates responsive multi-panel layout with optional sidebars */}
        {/* tabNames: Labels for main content panels (shown as tabs on mobile) */}
        {/* Shows all panels side-by-side in a grid */}
        <cf-autolayout tabNames={["Main", "Second"]}>
          {/* Left sidebar - use slot="left" */}
          <aside slot="left">
            <h3>Left Sidebar</h3>
            <p>Left content</p>
            <cf-button>Left Button</cf-button>
          </aside>

          {/* Main content panels - no slot attribute needed */}
          {/* Number of divs should match number of tabNames */}
          <div>
            <h1>Main Content Area</h1>
            <p>This is the main content with sidebars</p>
            <cf-button>Main Button</cf-button>
          </div>

          <div>
            <h1>Second Content Area</h1>
            <p>This is the second content with sidebars</p>
            <cf-button>Second Button</cf-button>
          </div>

          {/* Right sidebar - use slot="right" */}
          <aside slot="right">
            <h3>Right Sidebar</h3>
            <p>Right content</p>
            <cf-button>Right Button</cf-button>
          </aside>
        </cf-autolayout>

        {/* Footer slot - fixed at bottom */}
        <div slot="footer">
          <p>Footer Section</p>
        </div>
      </cf-screen>
    ),
  };
});
