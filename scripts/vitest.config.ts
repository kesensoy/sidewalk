import { defineConfig } from "vitest/config";
// The repo's own shape: the Claude Code plugin and marketplace manifests, and
// anything else scripts/ grows a test for.
export default defineConfig({ test: { include: ["*.test.ts"] } });
