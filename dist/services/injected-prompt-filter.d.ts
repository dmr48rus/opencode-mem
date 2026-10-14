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
export declare function getDefaultInjectionMarkers(): readonly string[];
/**
 * Returns true when `text` contains any configured injection marker.
 *
 * Matching is case-insensitive so that host variations in tag casing (for
 * example `<System-Reminder>`) are still recognised.
 */
export declare function containsInjectionMarker(text: string, markers?: readonly string[]): boolean;
/** Minimal shape this module needs from an OpenCode message part. */
export interface InjectionFilterablePart {
    readonly type?: string;
    readonly text?: string;
    readonly synthetic?: boolean;
}
/**
 * Returns true when a part was injected rather than typed by the user.
 *
 * A part counts as injected when it is flagged `synthetic` by the host, or when
 * its text carries a known injection marker.
 */
export declare function isInjectedPart(part: InjectionFilterablePart, markers?: readonly string[]): boolean;
/**
 * Drops injected parts and returns the user-authored text parts.
 *
 * When every part is injected the result is empty, signalling the caller to skip
 * recording the message entirely.
 */
export declare function filterInjectedParts<T extends InjectionFilterablePart>(parts: readonly T[], markers?: readonly string[]): T[];
//# sourceMappingURL=injected-prompt-filter.d.ts.map