/**
 * dsh-thinking-slider - host half.
 *
 * This plugin is entirely browser-side: it replaces the composer model seat
 * with a Codex-style reasoning-effort slider. The Host only needs the row to
 * exist so the composition loads `./client` (declared in package.json under
 * `dsh.client`); no Host Service, Event, or Config is contributed.
 */
export const name = 'dsh-thinking-slider'

/** No Host capabilities are required. */
export const inject = []

/** Host half is a no-op. */
export function apply() {}
