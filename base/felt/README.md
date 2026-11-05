# @commonfabric/felt

**F**ront**e**nd **L**ightweight **T**ooling

A lightweight frontend build tool.

## Config

Configuration can be stored in a project root's `felt.config.ts` file. Only
`entry` and `out` are required.

```ts
// felt.config.ts
export default {
  entry: "src/index.ts",
  out: "public/scripts/index.js",
  hostname: "127.0.0.1",
  port: 5173,
  publicDir: "public",
  watchDir: "src",
  esbuild: {
    sourcemap: true,
    minify: false,
    // https://esbuild.github.io/api/#external
    external: ["some-package-that-cant-be-resolved"],
    // Global variables to be replaced with static values.
    define: {
      "$DEBUG": Deno.env.get("DEBUG"),
    },
    // https://esbuild.github.io/api/#supported
    supported: {
      using: false,
    },
    tsconfigRaw: {
      compilerOptions: {
        useDefineForClassFields: false,
        experimentalDecorators: true,
      },
    },
  },
};
```

## Commands

- `felt build .`: Build current project.
- `felt serve .`: Serve current project.
- `felt dev .`: Serves current project, rebuilding and reloading on source
  change.
