import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "worker-configuration.d.ts"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  pack: {
    entry: {
      index: "src/index.ts",
      client: "src/client.ts",
      cfshare: "bin/cfshare.ts",
    },
    dts: true,
    format: ["esm"],
    platform: "node",
    fixedExtension: false,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
    sourcemap: true,
    outDir: "dist",
    clean: true,
    deps: {
      neverBundle: ["wrangler"],
    },
  },
});
