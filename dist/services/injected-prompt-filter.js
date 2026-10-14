/**
 * Filters out prompt text that was injected by the host or by other OpenCode
 * plugins, so it is never recorded as if the user had typed it.
 *
 * OpenCode surfaces plugin-injected content through the same `chat.message`
 * hook as genuine user input. Without this filter every injected block is
 * concatenated into `user_prompts.content`, which then feeds both auto-capture
 * and user-profile learning. The result is memories and a profile describing
 * another plugin's orchestration boilerplate instead of the user's actual work.
 *
 * Two layers are needed because injected content arrives in two shapes:
 *
 * 1. Whole messages that consist only of injected text (background-task
 *    notifications, continuation directives, orchestration status blocks).
 * 2. Mixed messages where an injected block is prepended to the real prompt.
 *
 * Structural detection (`synthetic === true`) is checked first but is not
 * sufficient on its own: plugins commonly inject through message paths that do
 * not set the flag, so textual markers carry most of the weight.
 */
/** Markers that identify a text block as machine-injected rather than typed. */
const DEFAULT_INJECTION_MARKERS = [
    // Generic host/plugin reminder wrapper used across the ecosystem.
    "<system-reminder>",
    // oh-my-openagent internal message markers. Documented in that plugin as the
    // canonical signal that a message originated from the harness, not the user.
    "<!-- OMO_INTERNAL_INITIATOR -->",
    "<!-- OMO_INTERNAL_NOREPLY -->",
    // oh-my-openagent unified directive prefix, described upstream as existing
    // specifically so downstream consumers can filter consistently.
    "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
    // Tool-output reminders that can reach the message stream.
    "[Agent Usage Reminder]",
    "[Category+Skill Reminder]",
    // Orchestration status blocks injected as standalone user messages.
    "<team_mode_status",
    "<auto-slash-command>",
];
export function getDefaultInjectionMarkers() {
    return DEFAULT_INJECTION_MARKERS;
}
/**
 * Returns true when `text` contains any configured injection marker.
 *
 * Matching is case-insensitive so that host variations in tag casing (for
 * example `<System-Reminder>`) are still recognised.
 */
export function containsInjectionMarker(text, markers = DEFAULT_INJECTION_MARKERS) {
    if (!text)
        return false;
    const haystack = text.toLowerCase();
    for (const marker of markers) {
        if (!marker)
            continue;
        if (haystack.includes(marker.toLowerCase()))
            return true;
    }
    return false;
}
/**
 * Returns true when a part was injected rather than typed by the user.
 *
 * A part counts as injected when it is flagged `synthetic` by the host, or when
 * its text carries a known injection marker.
 */
export function isInjectedPart(part, markers = DEFAULT_INJECTION_MARKERS) {
    if (part.synthetic === true)
        return true;
    return containsInjectionMarker(part.text ?? "", markers);
}
/**
 * Drops injected parts and returns the user-authored text parts.
 *
 * When every part is injected the result is empty, signalling the caller to skip
 * recording the message entirely.
 */
export function filterInjectedParts(parts, markers = DEFAULT_INJECTION_MARKERS) {
    return parts.filter((part) => !isInjectedPart(part, markers));
}
