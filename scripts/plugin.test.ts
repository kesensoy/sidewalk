/**
 * The Claude Code plugin and the marketplace that lists it, checked against
 * the shape the docs describe. `claude plugin validate .` is the authoritative
 * check and passes with one warning; it is not on every machine, so these are the
 * parts `npm test` can hold on its own.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson(".claude-plugin/plugin.json");
const mcpPkg = readJson("packages/sidewalk-mcp/package.json");

/** Every top-level key the manifest reference lists (2026-10-05). */
const MANIFEST_KEYS = new Set([
  "$schema", "name", "displayName", "version", "description", "author", "homepage", "repository",
  "license", "keywords", "metadata", "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl",
  "termsOfServiceUrl", "defaultEnabled", "dependencies", "settings", "userConfig", "types",
  "channels", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles",
  "workflows", "experimental",
]);
/** The marketplace reference's top-level fields. */
const MARKETPLACE_KEYS = new Set(["$schema", "name", "description", "owner", "plugins", "metadata"]);

describe("the marketplace manifest", () => {
  it("has the three required fields", () => {
    expect(marketplace.name).toBe("sidewalk");
    expect(marketplace.owner?.name).toBeTruthy();
    expect(Array.isArray(marketplace.plugins)).toBe(true);
  });

  it("writes no key the docs do not list", () => {
    expect(Object.keys(marketplace).filter(k => !MARKETPLACE_KEYS.has(k))).toEqual([]);
  });

  it("lists exactly one plugin, under the name its own manifest uses", () => {
    expect(marketplace.plugins).toHaveLength(1);
    // An install by the manifest name fails when the two differ.
    expect(marketplace.plugins[0].name).toBe(plugin.name);
    expect(marketplace.plugins[0].description).toBeTruthy();
  });

  it("points at the marketplace root, with no .. in the path", () => {
    const source: string = marketplace.plugins[0].source;
    expect(source).toBe(".");
    expect(source).not.toContain("..");
    // The plugin root is where its manifest and its skills are.
    expect(fs.existsSync(path.join(root, source, ".claude-plugin/plugin.json"))).toBe(true);
  });
});

describe("the plugin manifest", () => {
  it("is named in kebab-case and not after Anthropic's own", () => {
    expect(plugin.name).toBe("sidewalk");
    expect(plugin.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(plugin.name).not.toMatch(/^(claude|anthropic|anthropics|cc-plugin)-/);
  });

  it("writes no key the docs do not list", () => {
    expect(Object.keys(plugin).filter(k => !MANIFEST_KEYS.has(k))).toEqual([]);
  });

  it("carries the metadata a listing needs", () => {
    expect(plugin.description).toBeTruthy();
    expect(plugin.license).toBe("MIT");
    expect(plugin.author?.name).toBeTruthy();
    // `homepage` is optional and absent today: it was https://sidewalk.sh,
    // which has no A record yet (found in review). Checked again the
    // moment the manifest carries one.
    if (plugin.homepage !== undefined) expect(() => new URL(plugin.homepage)).not.toThrow();
    expect(() => new URL(plugin.repository)).not.toThrow();
  });

  it("runs the published MCP server, pinned to this release, not a path", () => {
    const servers = plugin.mcpServers;
    expect(Object.keys(servers)).toEqual(["sidewalk"]);
    const { command, args } = servers.sidewalk;
    expect(command).toBe("npx");
    expect(args).toEqual(["-y", `sidewalk-mcp@${mcpPkg.version}`]);
    // Exact, not `^` or `~`: npx serves a range from whatever it cached first
    // and never asks the registry again, so a range would not deliver patches
    // and would make the manifest say less than it does now.
    expect(mcpPkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(args[1].split("@")[1]).toMatch(/^\d+\.\d+\.\d+$/);
    // A path into the plugin would run the checkout, not the release.
    expect(args.join(" ")).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(args.join(" ")).not.toContain("/");
  });

  it("leaves no .mcp.json at the root, which would also be project scope", () => {
    expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(false);
  });
});

describe("the walk-author skill the plugin ships", () => {
  const skill = path.join(root, "skills/walk-author/SKILL.md");

  it("sits where the default skills/ scan looks, as one copy", () => {
    expect(fs.existsSync(skill)).toBe(true);
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(false);
    // One copy of it in the tree: the plugin reuses this file rather than
    // holding a second one that could drift from it. A new skill of its own is
    // welcome — under skills/, where the default scan finds it.
    const found = fs.globSync("**/SKILL.md", { cwd: root, exclude: p => p.includes("node_modules") });
    expect(found.filter(p => p.endsWith("walk-author/SKILL.md"))).toEqual(["skills/walk-author/SKILL.md"]);
    expect(found.filter(p => !p.startsWith("skills/"))).toEqual([]);
  });

  it("has the frontmatter Claude Code loads it by", () => {
    const text = fs.readFileSync(skill, "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    expect(front).toMatch(/^name: walk-author$/m);
    expect(front).toMatch(/^description: .+/m);
  });
});
