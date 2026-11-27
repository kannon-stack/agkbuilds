// Decorative ASCII pieces. All are hidden from screen readers.
import { EYE, LOGO } from "@/lib/asciiArt";

/** Fixed, centered eye that sits behind all page content. */
export function AsciiEye() {
  return (
    <div className="eye" aria-hidden="true">
      <div className="eye-in"><pre>{EYE}</pre></div>
    </div>
  );
}

export function AsciiLogo() {
  return <pre className="logo" aria-hidden="true">{LOGO}</pre>;
}

/** Three pre-computed frames, shown in turn by CSS. */
export function AsciiFlames({ frames }: { frames: string[] }) {
  return (
    <div className="wrap" aria-hidden="true">
      <div className="flames">
        <div className="flbox">
          {frames.map((frame, index) => (
            <pre key={index} className={`fl fl-${index + 1}`}>{frame}</pre>
          ))}
        </div>
      </div>
    </div>
  );
}

export function HatchBars() {
  return (
    <div className="hatch" aria-hidden="true">
      <div>{"/".repeat(240)}</div>
      <div>{"/ ".repeat(120)}</div>
    </div>
  );
}

export function RuleLine() {
  return <div className="ruleline" aria-hidden="true">{`+${"-".repeat(234)}+`}</div>;
}

const SPARKLE = ["    .", "   /|\\", "-=<-*->=-", "   \\|/", "    '    "].join("\n");

export function SparkleDivider() {
  return (
    <div className="sp" aria-hidden="true">
      <pre className="st">{SPARKLE}</pre>
      <div className="rule">
        <div className="rr">
          <span style={{ flex: 3 }}>{"=".repeat(64)}</span>
          <span style={{ flex: 3 }}>{"-".repeat(64)}</span>
          <span style={{ flex: 4 }}>{".".repeat(64)}</span>
        </div>
        <div className="rr">
          <span style={{ flex: 2 }}>{"-".repeat(64)}</span>
          <span style={{ flex: 2 }}>{".".repeat(64)}</span>
          <span style={{ flex: 6 }} />
        </div>
      </div>
    </div>
  );
}
