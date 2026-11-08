/**
 * Packaging config (electron-builder). Always passed explicitly: --config electron-builder.config.cjs (the npm scripts do this).
 *
 * Environment switches
 *   TALARIA_UNFUSED=1       skip Electron fuse hardening (needed only so Playwright can attach to a packaged build in tests)
 *   TALARIA_NO_EDIT_EXE=1   don't edit the Windows exe (icon/version) — lets you cross-build a Windows package on Linux without wine
 *   ELECTRON_DIST=<dir>     use a local Electron distribution instead of downloading one
 *   Signing: CSC_LINK / CSC_KEY_PASSWORD (macOS+Windows certs); notarization: APPLE_API_KEY(+_ID, _ISSUER) or
 *            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Without them builds are unsigned.
 */
// CI passes signing secrets as env vars even when they're not configured, i.e. as empty strings. electron-builder treats an
// empty CSC_LINK as a path (the project dir: "… not a file") and fails the macOS build, so drop empty ones = unsigned build.
for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  if (process.env[k] === '') delete process.env[k]
}
const unfused = !!process.env.TALARIA_UNFUSED
const notarize = !!(process.env.APPLE_API_KEY || process.env.APPLE_TEAM_ID)

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.talaria.desktop', // keep in sync with APP_ID in src/shared/types.ts
  productName: 'Talaria',
  copyright: 'Copyright © 2026 Dylan Borgen',
  directories: { output: 'release', buildResources: 'build' },
  // Only the bundled output ships; runtime `dependencies` (MCP SDK, yaml, zod) are added automatically.
  files: ['out/**/*', 'package.json', '!**/*.map'],
  extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
  asar: true,
  publish: null, // no auto-update channel yet (see DESIGN.md → Packaging)
  ...(process.env.ELECTRON_DIST ? { electronDist: process.env.ELECTRON_DIST } : {}),
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

  // Harden the Electron binary itself (disables features an attacker could abuse to run our app as a generic Node).
  ...(unfused
    ? {}
    : {
        electronFuses: {
          runAsNode: false,
          enableNodeOptionsEnvironmentVariable: false,
          enableNodeCliInspectArguments: false,
          enableCookieEncryption: true,
          onlyLoadAppFromAsar: true
        }
      }),

  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize
  },
  dmg: { sign: false },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }, { target: 'zip', arch: ['x64'] }],
    ...(process.env.TALARIA_NO_EDIT_EXE ? { signAndEditExecutable: false } : {})
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // Uninstalling removes the app, never your chats, memory or settings.
    deleteAppDataOnUninstall: false
  },

  linux: {
    target: ['AppImage', 'deb', 'tar.gz'],
    category: 'Utility',
    executableName: 'talaria',
    syncDesktopName: true,
    maintainer: 'Dylan Borgen <dylanborgen@gmail.com>',
    synopsis: 'Customizable AI chat with tools, MCP, memory and skills',
    description: 'Talaria is a desktop chat client for OpenAI-compatible models with file/shell/web tools (with approvals), MCP servers, memory, skills and themes.'
  },
  deb: { depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0'] }
}
