/** Primary modifier key as shown in the UI (⌘ on macOS, Ctrl elsewhere). The key handlers accept both. */
export const MOD = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl'
