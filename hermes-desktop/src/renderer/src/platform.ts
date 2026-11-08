export const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform)
/** Primary modifier key as shown in the UI (⌘ on macOS, Ctrl elsewhere). The key handlers accept both. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'
