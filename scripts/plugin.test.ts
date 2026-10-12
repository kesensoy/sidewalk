/**
 * The Claude Code plugin and the marketplace that lists it, checked against
 * the shape the docs describe. `claude plugin validate .` checks the marketplace
 * and the manifest, and `claude plugin validate ./plugin` opens the skill too;
 * both pass clean. Neither is on every machine, so these are the parts
 * `npm test` can hold on its own.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

const marketplace = readJson(".claude-plugin/marketplace.json");
const plugin = readJson("plugin/.claude-plugin/plugin.json");
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
    // The marketplace's description is what a listing shows; one sentence, in
    // both places, so neither can go stale alone.
    expect(marketplace.plugins[0].description).toBe(plugin.description);
  });

  it("points at the plugin folder, with no .. in the path", () => {
    const source: string = marketplace.plugins[0].source;
    expect(source).toBe("./plugin");
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

  it("ships what a listing needs beside the manifest", () => {
    expect(fs.existsSync(path.join(root, "plugin/LICENSE"))).toBe(true);
    // The icon the manifest declares is the file that exists; the directory
    // reads it once, at the first submission.
    expect(plugin.icon).toBe("./.claude-plugin/icon.png");
    expect(fs.existsSync(path.join(root, "plugin", plugin.icon))).toBe(true);
    // No package.json beside the manifest: Claude Code would npm-install its
    // lockfile into every copy of the plugin, for a server npx fetches anyway.
    expect(fs.existsSync(path.join(root, "plugin/package.json"))).toBe(false);
    const readme = fs.readFileSync(path.join(root, "plugin/README.md"), "utf8");
    expect(readme.split(/\s+/).length).toBeGreaterThan(40);
  });

  it("leaves no .mcp.json at the root, which would also be project scope", () => {
    expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(false);
  });
});

describe("the walk-author skill the plugin ships", () => {
  const skill = path.join(root, "plugin/skills/walk-author/SKILL.md");

  it("sits where the default skills/ scan looks, as one copy", () => {
    expect(fs.existsSync(skill)).toBe(true);
    expect(fs.lstatSync(skill).isSymbolicLink()).toBe(false);
    // One copy of it in the tree. A new skill of its own is welcome — under
    // plugin/skills/, where the plugin's scan finds it.
    // Node's glob joins with the platform separator; compare forward slashes.
    const found = fs.globSync("**/SKILL.md", { cwd: root, exclude: p => p.includes("node_modules") }).map(p => p.split(path.sep).join("/"));
    expect(found.filter(p => p.endsWith("walk-author/SKILL.md"))).toEqual(["plugin/skills/walk-author/SKILL.md"]);
    expect(found.filter(p => !p.startsWith("plugin/skills/"))).toEqual([]);
  });

  it("has the frontmatter Claude Code loads it by", () => {
    const text = fs.readFileSync(skill, "utf8");
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    expect(front).toMatch(/^name: walk-author$/m);
    expect(front).toMatch(/^description: .+/m);
  });

  /**
   * The skill and the MCP server's instructions are the same guidance in two
   * places, and the one place they are easiest to let drift is a sentence added
   * to one of them. The skill is Markdown — reflowed, with backticks round the
   * tool names — so they are not byte-identical and cannot be; what is compared
   * is the sentences, with the wrapping and the backticks taken out.
   *
   * Anything added to either file that a reader is meant to act on belongs in
   * both, and belongs in this list.
   */
  it("says the same sentences as the MCP server's instructions where the two overlap", () => {
    const flat = (s: string) => s.replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    const guide = flat(fs.readFileSync(path.join(root, "packages/sidewalk-mcp/src/instructions.ts"), "utf8"));
    const text = flat(fs.readFileSync(skill, "utf8"));
    const BOTH = [
      "viewers is how many panels hold walkd's stream. At 0 nobody is watching: tell the person to open the sidewalk side panel. If they say it asks for a token, say walkd put it on their clipboard when it started, or give them: npx -y sidewalk-walkd token --copy. Never ask for the token and never print one.",
      "walk_open returns it, and so does a walk_wait that comes back empty. started: true on walk_open means this session started walkd itself, so the person has seen nothing about it at all.",
      "A verdict's text is the person's words verbatim: quote it, never paraphrase or trim it.",
      "Nothing can push to you.",
    ];
    for (const sentence of BOTH) {
      expect(guide, `instructions.ts is missing: ${sentence}`).toContain(flat(sentence));
      expect(text, `SKILL.md is missing: ${sentence}`).toContain(flat(sentence));
    }
    // And never the token itself, in either: the agent is told the fact, never
    // handed the secret.
    for (const s of [guide, text]) expect(s).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});
