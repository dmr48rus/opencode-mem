/** OpenCode-compatible skill id: lowercase kebab-case, 1–64 chars. */
export const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function isValidSkillId(id) {
    return id.length >= 1 && id.length <= 64 && SKILL_ID_PATTERN.test(id);
}
