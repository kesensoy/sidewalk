import { defineConfig } from "vitest/config";
// `scripts/` is in the list because the Firefox manifest patch lives there and
// is a pure function with a test beside it. It is not type-checked (tsconfig's
// `include` is `src`), so that test is the only thing holding its shape.
export default defineConfig({ test: { environment: "happy-dom", include: ["src/**/*.test.ts", "scripts/**/*.test.ts"] } });
