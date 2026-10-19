import { isAbsolute, resolve } from "node:path";
import { log } from "../services/logger.js";
import { onSkillsChanged, skillsManager } from "../services/skills/skills-manager.js";
import { eventBelongsToLocation, legacyToolResult, toLegacyEvent } from "./legacy-client.js";
const memoryInput = {
    type: "object",
    properties: {
        mode: {
            type: "string",
            enum: [
                "add",
                "search",
                "profile",
                "list",
                "forget",
                "help",
                "migrate",
                "list-shards",
                "export",
                "import",
            ],
        },
        content: { type: "string" },
        query: { type: "string" },
        tags: { type: "string" },
        type: { type: "string" },
        memoryId: { type: "string" },
        limit: { type: "number" },
        scope: { type: "string", enum: ["project", "all-projects"] },
        fromPath: { type: "string" },
        fromHash: { type: "string" },
        outputPath: { type: "string" },
        inputPath: { type: "string" },
        dryRun: { type: "boolean" },
        allowLinkedSource: { type: "boolean" },
    },
    additionalProperties: false,
};
export async function registerV2Adapter(ctx, legacy) {
    const contexts = new Map();
    const messageIDs = new Map();
    const suppressed = new Set();
    const memoryContext = legacy.memoryContext;
    /** Skill IDs last registered from opencode-mem DB (so we can remove stale ones). */
    const registeredSkillIds = new Set();
    async function registerDbSkills() {
        // Before the early return, so the log says which of the two possible
        // reasons applies when nothing is registered: no skill hook on this host,
        // or a hook without a transform.
        log("Skill registration: entering", {
            enabled: !!ctx.skill?.transform,
            type: typeof ctx.skill?.transform,
        });
        if (!ctx.skill?.transform)
            return;
        // No project tag. The skills store is the shared server-side store, and a
        // skill in it is in it for every project, exactly like remote memory. The
        // container_tag column is still written and still in the schema; it is just
        // no longer how visibility is decided. Filtering here would hide the global
        // rows from any client that has no project tag of its own.
        let skills = [];
        try {
            skills = await skillsManager.list({ enabledOnly: true });
        }
        catch (error) {
            log("Failed to load skills for OpenCode registration", { error: String(error) });
            return;
        }
        const nextIds = new Set(skills.map((skill) => skill.id));
        // The bookkeeping lives inside the callback on purpose. Measured 15.10.2026:
        // await on transform() neither resolves nor rejects during startup -- the
        // host invokes the callback itself and the skill does reach the registry --
        // so anything placed after the await never runs. Stale removal depends on
        // knowing what was registered last time, and it has to be recorded where the
        // registration actually happens.
        void ctx.skill
            .transform((editor) => {
            // Only ids this plugin registered may be removed. The editor also holds
            // the host's own file-based skills, which belong to the user and are not
            // in this database; sweeping editor.list() for "not ours" deletes those
            // too. Measured 15.10.2026: that mistake took autoresearch, clm-context,
            // init-second-brain and reverse-engineer-anything out of the skill list.
            for (const id of registeredSkillIds) {
                if (!nextIds.has(id) && editor.get(id)) {
                    editor.remove(id);
                }
            }
            registeredSkillIds.clear();
            for (const id of nextIds)
                registeredSkillIds.add(id);
            for (const skill of skills) {
                // Skill.Info requires an absolute path even for a skill whose content
                // travels inline, so the SKILL.md is written next to the store. It is
                // a derived copy of what the server holds, not a second source: the
                // row on the server is what create/update/delete act on.
                const path = skillsManager.skillPath(skill.id);
                const absolutePath = isAbsolute(path) ? path : resolve(path);
                // The description is REQUIRED by the host schema, and a schema error
                // disables the WHOLE plugin - not the one skill. Measured 19.10.2026:
                // eight fixture skills on the server had an empty description and the
                // memory plugin stopped loading entirely (port 4748 never came up).
                // So the description is always a string, even when the row has none.
                const description = typeof skill.description === "string" && skill.description.trim()
                    ? skill.description
                    : `Skill ${skill.name} (no description)`;
                const payload = {
                    id: skill.id,
                    name: skill.name,
                    description,
                    autoinvoke: skill.autoinvoke,
                    path: absolutePath,
                    content: skill.content,
                };
                if (editor.get(skill.id)) {
                    editor.update(skill.id, (entry) => {
                        entry.name = payload.name;
                        entry.description = payload.description;
                        entry.autoinvoke = payload.autoinvoke;
                        entry.path = payload.path;
                        entry.content = payload.content;
                    });
                }
                else {
                    editor.add(payload);
                }
            }
            log("Registered shared skills with OpenCode", {
                count: skills.length,
                ids: skills.map((skill) => skill.id),
            });
        })
            .catch((error) => {
            log("Shared skill registration failed", { error: String(error) });
        });
    }
    await ctx.tool.transform((editor) => editor.add({
        name: "memory",
        description: legacy.tool.memory.description,
        input: memoryInput,
        execute: async (args, toolContext) => legacyToolResult(await legacy.tool.memory.execute(args, {
            sessionID: toolContext.sessionID,
            messageID: toolContext.messageID,
            agent: toolContext.agent,
            directory: ctx.location.directory,
            worktree: ctx.location.project.directory,
            abort: new AbortController().signal,
            metadata() { },
            async ask() { },
        })),
    }));
    await registerDbSkills();
    const unsubscribeSkills = onSkillsChanged(() => {
        void (async () => {
            try {
                await registerDbSkills();
                await ctx.skill?.reload?.();
            }
            catch (error) {
                log("Failed to reload OpenCode skills after DB change", { error: String(error) });
            }
        })();
    });
    await ctx.session.hook("prompt", async (event) => {
        messageIDs.set(event.sessionID, event.messageID);
        const original = { type: "text", text: event.prompt.text };
        const output = { message: { id: event.messageID }, parts: [original] };
        if (memoryContext) {
            try {
                if (!(await memoryContext.capturePrompt({ sessionID: event.sessionID }, output))) {
                    suppressed.add(event.sessionID);
                    return;
                }
                suppressed.delete(event.sessionID);
                // In V1, the first injected part remains in history. V2 system parts
                // exist only for one request, so retain that context across user turns.
                if (memoryContext.refreshOnPrompt())
                    contexts.delete(event.sessionID);
                if (!contexts.has(event.sessionID)) {
                    contexts.set(event.sessionID, await memoryContext.load(event.sessionID));
                }
            }
            catch (error) {
                contexts.delete(event.sessionID);
                log("V2 prompt memory context failed", { error: String(error) });
            }
            return;
        }
        contexts.delete(event.sessionID);
        if (!legacy["chat.message"])
            return;
        await legacy["chat.message"]({ sessionID: event.sessionID }, output);
        const injected = output.parts
            .filter((part) => part !== original && part?.type === "text")
            .map((part) => part.text)
            .join("\n");
        if (injected)
            contexts.set(event.sessionID, injected);
    });
    await ctx.session.hook("context", async (event) => {
        if (memoryContext) {
            if (!memoryContext.enabled()) {
                contexts.clear();
            }
            else if (!suppressed.has(event.sessionID) && !contexts.has(event.sessionID)) {
                try {
                    // Rehydrate from the canonical memory store, without replaying the
                    // prompt hook or persisting a second plaintext copy in host storage.
                    contexts.set(event.sessionID, await memoryContext.load(event.sessionID));
                }
                catch (error) {
                    log("V2 restored memory context failed", { error: String(error) });
                }
            }
        }
        const injected = suppressed.has(event.sessionID) ? undefined : contexts.get(event.sessionID);
        if (injected)
            event.system.push({ type: "text", text: injected });
        if (legacy["chat.params"]) {
            await legacy["chat.params"]({
                message: { id: messageIDs.get(event.sessionID) ?? event.sessionID },
                model: { providerID: event.model.providerID, id: event.model.id },
            });
        }
    });
    const controller = new AbortController();
    const watcher = (async () => {
        if (!legacy.event)
            return;
        try {
            for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
                if (await eventBelongsToLocation(ctx, raw)) {
                    const event = toLegacyEvent(raw);
                    if (event.type === "session.compacted" && event.properties?.sessionID) {
                        contexts.delete(event.properties.sessionID);
                    }
                    await legacy.event({ event });
                }
            }
        }
        catch (error) {
            if (!controller.signal.aborted) {
                console.error("opencode-mem event bridge failed", error);
            }
        }
    })();
    return async () => {
        unsubscribeSkills();
        controller.abort();
        await watcher;
        contexts.clear();
        messageIDs.clear();
        suppressed.clear();
        await legacy.dispose?.();
    };
}
