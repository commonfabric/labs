const ED25519_FLAG = "--enable-experimental-web-platform-features";
export default {
  product: "chrome",
  args: [ED25519_FLAG],
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
