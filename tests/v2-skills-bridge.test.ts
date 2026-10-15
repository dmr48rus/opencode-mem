import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { tursoConnectionManager } from "../src/services/turso/connection-manager.js";
import { registerV2Adapter } from "../src/v2/adapter.js";

let tmpDir: string;

describe("V2 skills bridge helpers", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-mem-v2-skills-"));
    const { CONFIG } = await import("../src/config.js");
    CONFIG.storagePath = tmpDir;
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
  });

  afterEach(async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    skillsManager.reset();
    await tursoConnectionManager.closeAll();
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("exposes absolute skill paths for OpenCode Skill.Info", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "bridge-demo",
      name: "Bridge Demo",
      description: "demo",
      content: "Do the thing.",
    });
    const path = skillsManager.skillPath("bridge-demo");
    expect(isAbsolute(path)).toBe(true);
    expect(path.replace(/\\/g, "/").endsWith("bridge-demo/SKILL.md")).toBe(true);
    expect(existsSync(path)).toBe(true);
    const md = readFileSync(path, "utf8");
    expect(md).toContain('name: "Bridge Demo"');
    expect(md).toContain("Do the thing.");
    expect(md).toContain('opencode/autoinvoke: "true"');
  });

  it("lists only enabled skills for registration filtering", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "on",
      name: "On",
      content: "a",
      enabled: true,
    });
    await skillsManager.create({
      id: "off",
      name: "Off",
      content: "b",
      enabled: false,
    });
    const enabled = await skillsManager.list({ enabledOnly: true });
    expect(enabled.map((s) => s.id)).toEqual(["on"]);
    expect(existsSync(skillsManager.skillPath("on"))).toBe(true);
    expect(existsSync(skillsManager.skillPath("off"))).toBe(false);
  });

  it("registers enabled DB skills through OpenCode skill.transform", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "code-review",
      name: "Code Review",
      description: "Review diffs",
      content: "## Review\n\nBe thorough.",
      autoinvoke: true,
      enabled: true,
    });
    await skillsManager.create({
      id: "disabled-skill",
      name: "Disabled",
      content: "hidden",
      enabled: false,
    });

    const registry = new Map<string, any>();
    let reloadCount = 0;
    const hooks = new Map<string, (event: any) => Promise<void>>();

    const ctx = {
      location: {
        directory: "/workspace/project",
        project: { id: "project", directory: "/workspace/project", canonical: "project" },
      },
      tool: {
        transform: async (callback: (editor: any) => void) => {
          callback({ add() {} });
        },
      },
      skill: {
        transform: async (callback: (editor: any) => void) => {
          callback({
            get: (id: string) => registry.get(id),
            add: (skill: any) => {
              registry.set(skill.id, { ...skill });
            },
            update: (id: string, mutate: (skill: any) => void) => {
              const current = registry.get(id);
              if (!current) return;
              mutate(current);
            },
            remove: (id: string) => {
              registry.delete(id);
            },
          });
        },
        reload: async () => {
          reloadCount++;
        },
      },
      session: {
        hook: async (name: string, callback: (event: any) => Promise<void>) => {
          hooks.set(name, callback);
        },
      },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          );
          // Satisfy require-yield; cleanup aborts before any events are needed.
          if (signal.aborted) yield null;
        },
      },
    } as any;

    const cleanup = await registerV2Adapter(ctx, {
      tool: { memory: { description: "memory", execute: async () => "{}" } },
      event: async () => {},
      dispose: async () => {},
    });

    expect([...registry.keys()].sort()).toEqual(["code-review"]);
    const registered = registry.get("code-review");
    expect(registered.name).toBe("Code Review");
    expect(registered.description).toBe("Review diffs");
    expect(registered.autoinvoke).toBe(true);
    expect(registered.content).toBe("## Review\n\nBe thorough.");
    expect(registered.path).toBe(skillsManager.skillPath("code-review"));
    expect(existsSync(registered.path)).toBe(true);

    await skillsManager.update("code-review", {
      description: "Review PRs carefully",
      autoinvoke: false,
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.get("code-review")?.description).toBe("Review PRs carefully");
    expect(registry.get("code-review")?.autoinvoke).toBe(false);
    expect(reloadCount).toBeGreaterThan(0);

    await skillsManager.update("code-review", { enabled: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(registry.has("code-review")).toBe(false);

    await cleanup();
  });

  it("leaves the host's own file skills alone", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "our-skill",
      name: "Ours",
      content: "ours",
      enabled: true,
    });

    // The registry holds skills this plugin never registered: the host's own
    // file-based ones. list() is implemented on purpose, so a sweep over "not in
    // our database" would actually run here instead of crashing on a missing
    // method and hiding itself.
    const registry = new Map<string, any>([
      ["autoresearch", { id: "autoresearch", name: "autoresearch", content: "file" }],
      ["clm-context", { id: "clm-context", name: "clm-context", content: "file" }],
    ]);

    const ctx = {
      location: {
        directory: "/workspace/project",
        project: { id: "project", directory: "/workspace/project", canonical: "project" },
      },
      tool: { transform: async (cb: (e: any) => void) => cb({ add() {} }) },
      skill: {
        transform: async (cb: (editor: any) => void) => {
          cb({
            list: () => [...registry.values()],
            get: (id: string) => registry.get(id),
            add: (skill: any) => registry.set(skill.id, { ...skill }),
            update: (id: string, mutate: (s: any) => void) => {
              const current = registry.get(id);
              if (current) mutate(current);
            },
            remove: (id: string) => registry.delete(id),
          });
        },
        reload: async () => {},
      },
      session: { hook: async () => {} },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((r) =>
            signal.addEventListener("abort", () => r(), { once: true })
          );
          if (signal.aborted) yield null;
        },
      },
    } as any;

    const cleanup = await registerV2Adapter(ctx, {
      tool: { memory: { description: "memory", execute: async () => "{}" } },
      event: async () => {},
      dispose: async () => {},
    });

    expect(registry.has("our-skill")).toBe(true);
    expect(registry.has("autoresearch")).toBe(true);
    expect(registry.has("clm-context")).toBe(true);

    await cleanup();
  });

  it("builds OpenCode HTTP catalog markdown with autoinvoke metadata", async () => {
    const { skillsManager } = await import("../src/services/skills/skills-manager.js");
    await skillsManager.create({
      id: "git-release",
      name: "Git Release",
      description: "Cut a release",
      content: "Tag and publish.",
      autoinvoke: false,
    });

    const catalog = await skillsManager.toHttpCatalog();
    expect(catalog.skills).toEqual([
      {
        name: "git-release",
        version: expect.any(String),
        files: ["git-release.md"],
      },
    ]);

    const md = await skillsManager.toCatalogMarkdown("git-release");
    expect(md).toContain('name: "Git Release"');
    expect(md).toContain('description: "Cut a release"');
    expect(md).toContain('opencode/autoinvoke: "false"');
    expect(md).toContain("Tag and publish.");
  });
});
