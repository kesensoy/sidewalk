import { defineConfig } from "vitest/config";
// The one-page site: the install script and what serve.mjs answers for it.
export default defineConfig({ test: { include: ["*.test.ts"] } });
