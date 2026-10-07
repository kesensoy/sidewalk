import { defineConfig } from "vitest/config";
// Anything under demo/, not only the two at the top level.
export default defineConfig({ test: { include: ["**/*.test.ts"] } });
