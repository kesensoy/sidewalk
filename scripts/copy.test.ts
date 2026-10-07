/**
 * The copy rule, made a test.
 *
 * Words a person reads — PRIVACY.md, site/privacy.html, the store listing's
 * prose, every string the pane shows — are the copy reviewer's to settle. An
 * implementer who has to write one marks the line, so the reviewer can find it
 * by grep instead of by diff, and this test is what stops a marked line from
 * shipping: it fails while any marker is still in the tree, naming the files.
 *
 * So a failure here is not a defect in the code. It means the copy has been
 * written but not yet read by the person whose call it is. Clear it by settling
 * the words and taking the markers out, never by excluding a file below.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
/** Assembled, so this file is not itself a hit. */
const MARKER = ["TODO", "COPY", "REVIEW"].join("-");
/** Anything that is not text; a marker cannot be in one, and reading it is waste. */
const BINARY = /\.(png|jpe?g|gif|ico|zip|woff2?|ttf|otf|mp4|mov|pdf|jsonl)$/i;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20 })
  .split("\0")
  .filter(f => f && !BINARY.test(f));

describe("the copy review marker", () => {
  it("is in no tracked file", () => {
    const carrying = tracked.filter(f => {
      const p = path.join(root, f);
      return fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(MARKER);
    });
    expect(carrying).toEqual([]);
  });
});
