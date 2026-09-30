export default {
  // The guest runs in an iframe the test page creates, which loads its module
  // by URL and so cannot share the test's own bundle.
  bundle: {
    "src/guest.ts": "guest.js",
  },
  // An outer frame served from a URL, as a host serving its own serves it
  // (`outerFrameUrl`): a document, and the outer frame's script as it
  // stands.
  include: {
    "test/fixtures/outer-frame.html": "outer-frame.html",
    "src/outer-frame-script.js": "outer-frame-script.js",
  },
  esbuildConfig: {
    supported: {
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        // `useDefineForClassFields` is critical when using Lit
        // with esbuild, even when not using decorators.
        useDefineForClassFields: false,
      },
    },
  },
};
