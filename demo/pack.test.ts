/**
 * The walk pack is data, and data rots quietly: an item the schema refuses is
 * only found when the demo is being filmed, and a `target` naming a
 * `[data-walk]` nobody put on the page outlines nothing and says nothing.
 * Both are caught here.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { itemInputSchema, walkInputSchema } from "sidewalk-walkd/schema";
// @ts-expect-error — the demo site is plain .mjs, with no types to import.
import { PAGES } from "./site/serve.mjs";

const HERE = import.meta.dirname;
const SITE = "http://127.0.0.1:9350/";
const pack = JSON.parse(fs.readFileSync(path.join(HERE, "walk.json"), "utf8"));
const items: any[] = [...pack.groups.flatMap((g: any) => g.items), pack.ask];
const named = (i: any) => [i.id, i] as const;

it("the walk header is one walk_open would take", () => {
  expect(walkInputSchema.parse(pack.walk).project).toBe("lamppost");
});

it("has both groups, in the order the launcher lands them", () => {
  expect(pack.groups.map((g: any) => g.name)).toEqual(["home and lamps", "settings"]);
});

describe.each(items.map(named))("%s", (_id, item) => {
  it("parses as an item", () => {
    expect(itemInputSchema.parse(item).kind).toBe(item.kind);
  });

  it("points at the demo site", () => {
    if (item.url === undefined) return;
    expect(item.url.startsWith(SITE)).toBe(true);
  });

  /**
   * A `walkId` target is `[data-walk="…"]` on the page the item's url names.
   * The attribute has to be in the HTML the server sends, not written in by
   * script, or Go outlines nothing.
   */
  it("outlines something that is on its page", () => {
    if (item.target?.walkId === undefined) return;
    const name = new URL(item.url).pathname.replace(/\/+$/, "") || "/";
    const file = (PAGES as Record<string, string>)[name];
    expect(file, `no page serves ${name}`).toBeTruthy();
    const html = fs.readFileSync(path.join(HERE, "site", file), "utf8");
    expect(html).toContain(`data-walk="${item.target.walkId}"`);
  });
});
