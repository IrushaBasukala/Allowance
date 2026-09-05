import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// import.meta.dirname rather than __dirname: this file is ESM, and Vite's
// native config loader (soon the default) does not provide CJS globals.
const pkg = (n: string) =>
  resolve(import.meta.dirname, `packages/${n}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      "@allowance/envelope": pkg("envelope"),
      "@allowance/policy": pkg("policy"),
      "@allowance/reputation": pkg("reputation"),
      "@allowance/receipts": pkg("receipts"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
