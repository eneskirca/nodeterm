// A launch prompt spilled to a file (#706) is read when the node LAUNCHES, not when it is opened.
// For a cold-opened node that is whenever its project is next viewed — possibly weeks later — so the
// file cannot live under the uploads staging area, which is swept after 7 days on the next paste.
// The renderer names its spills with this prefix; the core writing them (`saveUpload`) puts that
// name under its own root with its own, longer TTL. Shared so the two sides cannot disagree.

export const LAUNCH_PROMPT_FILE_PREFIX = 'nodeterm-prompt-'

/**
 * How long a spilled prompt is kept. Longer than the longest `--after-pr` deadline (14 days) with a
 * wide margin, but a cold open waits for a human to look at its project, which can be longer still:
 * the delivery loop therefore checks that the file is there before it types the launch
 * (`LaunchToFire.briefFile`) and holds the node for ▶ with the reason when it is not.
 */
export const LAUNCH_PROMPT_TTL_MS = 30 * 86_400_000
