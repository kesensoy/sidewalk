/**
 * Every test in this package runs with `WALKD_NATIVE_ROOT` pointing at a throwaway
 * directory.
 *
 * `walkd serve` writes native messaging manifests into the browser profiles of
 * whoever is running it, and the only thing standing between a test run and the
 * person's own Chrome is that variable. The tests that spawn the CLI set it
 * themselves, by name, where a reader can see it; this file is the net under
 * them, so a test that forgets lands in a temp directory instead of in
 * `~/Library/Application Support/Google/Chrome/`.
 *
 * It was written after a run without the net put ten manifests into ten real
 * browser profiles.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "walkd-test-native-root-"));
process.env.WALKD_NATIVE_ROOT = root;

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
