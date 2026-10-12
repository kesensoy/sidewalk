import { defineConfig } from "vitest/config";
// `setupFiles` points WALKD_NATIVE_ROOT at a temp directory for every test in
// this package, so nothing here can write a native messaging manifest into a
// real browser profile. See test/native-root.ts.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], setupFiles: ["test/native-root.ts"] } });
