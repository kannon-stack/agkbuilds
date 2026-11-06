/**
 * Decorative pieces. The borders are drawn from text characters (ASCII art);
 * the background is a scatter of small rotated diamonds.
 */

const STAR_ART = ["    .    ", "   /|\\   ", "-=<-*->=-", "   \\|/   ", "    '    "];
const STAR_SMALL_ART = [" . ", "-*-", " ' "];

/** Four-point sparkle drawn in characters. */
export function Star({ className = "", small = false }: { className?: string; small?: boolean }) {
  return (
    <pre className={`ascii-star ${small ? "ascii-star-small" : ""} ${className}`} aria-hidden="true">
      {(small ? STAR_SMALL_ART : STAR_ART).join("\n")}
    </pre>
  );
}

// Each row is a run of characters per segment; flex weights set how far each run goes,
// so the rule thins from heavy "=" to "-" to "." like the tapering lines in the reference.
const TAPER_ROWS: Array<Array<[string | null, number]>> = [
  [["=", 3], ["-", 3], [".", 4]],
  [["-", 2], [".", 3], [null, 5]],
];

function AsciiRule({ reverse = false }: { reverse?: boolean }) {
  return (
    <div className={`ascii-rule ${reverse ? "ascii-rule-reverse" : ""}`} aria-hidden="true">
      {TAPER_ROWS.map((row, rowIndex) => (
        <div className="rule-row" key={rowIndex}>
          {row.map(([glyph, weight], segmentIndex) => (
            <span className="rule-seg" style={{ flex: weight }} key={segmentIndex}>
              {glyph ? glyph.repeat(500) : ""}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Section divider. "left" puts the star at the start with a small one at the end;
 * "center" runs a taper out of both sides of a single star.
 */
export function SparkleDivider({ variant = "left" }: { variant?: "left" | "center" }) {
  return (
    <div className={`sparkle-divider sparkle-${variant}`} aria-hidden="true">
      {variant === "center" && <AsciiRule reverse />}
      <Star />
      <AsciiRule />
      {variant === "left" && <Star small />}
    </div>
  );
}

const HATCH_DENSE = "/".repeat(600);
const HATCH_SPARSE = "/ ".repeat(300);

/** Slanted hatch bar made of slashes, like the striped strips in the border reference. */
export function HatchStrip({ className = "" }: { className?: string }) {
  return (
    <div className={`ascii-hatch ${className}`} aria-hidden="true">
      <div>{HATCH_DENSE}</div>
      <div>{HATCH_SPARSE}</div>
    </div>
  );
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tile of jittered, rotated squares in varied sizes and opacities. */
function makeDiamondTile(seed: number, size = 360, step = 22) {
  const random = mulberry32(seed);
  const colors = ["#b8f23a", "#d9ff91", "#7ef2bd", "#90d9ff", "#b8f23a"];
  const cells = Math.floor(size / step);
  const shapes: string[] = [];
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      if (random() < 0.22) continue;
      const side = 1.6 + random() ** 2 * 6.5;
      const margin = side * 0.75 + 1;
      const x = Math.min(size - margin, Math.max(margin, (column + 0.5) * step + (random() - 0.5) * step * 0.75));
      const y = Math.min(size - margin, Math.max(margin, (row + 0.5) * step + (random() - 0.5) * step * 0.75));
      const angle = 36 + random() * 16;
      const opacity = (0.12 + random() * 0.55).toFixed(2);
      const color = colors[Math.floor(random() * colors.length)];
      shapes.push(
        `<rect x="${(-side / 2).toFixed(1)}" y="${(-side / 2).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" fill="${color}" fill-opacity="${opacity}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(0)})"/>`,
      );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${shapes.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const TILE_UP = makeDiamondTile(11);
const TILE_DOWN = makeDiamondTile(29);

/** Two diamond layers drifting in opposite vertical directions. */
export function DiamondField() {
  return (
    <>
      <div className="ascii-diamonds diamonds-up" style={{ backgroundImage: TILE_UP }} aria-hidden="true" />
      <div className="ascii-diamonds diamonds-down" style={{ backgroundImage: TILE_DOWN }} aria-hidden="true" />
    </>
  );
}
