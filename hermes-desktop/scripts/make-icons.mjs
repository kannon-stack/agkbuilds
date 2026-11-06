// Renders build/icon.svg → build/icon.png (1024²) and a few sizes. electron-builder derives .ico/.icns from the PNG.
// Pure JS (resvg) so the result is identical on every machine. Run: npm run icons
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(path.join(root, 'build/icon.svg'))
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

writeFileSync(path.join(root, 'build/icon.png'), render(1024))
mkdirSync(path.join(root, 'build/icons'), { recursive: true })
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(path.join(root, `build/icons/${s}x${s}.png`), render(s))
console.log('wrote build/icon.png and build/icons/*.png')
