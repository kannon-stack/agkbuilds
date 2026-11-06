import { useEffect, useRef } from "react";
import { BANNER_COLUMNS, BANNER_LINES } from "@/lib/asciiBanner";

/**
 * Fixed full-viewport background: the AGK BUILDS ASCII banner, gradient-filled,
 * with a dark scrim over it so the page content stays readable.
 */
export function AsciiBackdrop() {
  return (
    <div className="ascii-backdrop" aria-hidden="true">
      <pre className="ascii-banner" style={{ ["--banner-cols" as string]: BANNER_COLUMNS }}>
        {BANNER_LINES.join("\n")}
      </pre>
      <div className="ascii-scrim" />
    </div>
  );
}

const RAMP = " .:-=+*#%@";

type FlameProps = {
  className?: string;
  /** Height of the flame field in character rows. */
  rows?: number;
  /** 0–1: how many columns ignite. Lower = sparser tongues of fire. */
  density?: number;
};

/**
 * ASCII fire. A coarse heat buffer is cooled and diffused upward each tick and
 * drawn as characters from RAMP. Only a few drifting columns are fuelled, so the
 * flames read as occasional tongues rather than a solid wall.
 */
export function AsciiFlame({ className = "", rows = 12, density = 0.3 }: FlameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fontSize = 13;
    const cellWidth = fontSize * 0.6;
    const cellHeight = fontSize * 1.18;
    let cols = 0;
    let heat: Float32Array = new Float32Array(0);
    let width = 0;
    let height = 0;
    let frame = 0;
    let visible = true;
    let lastTick = 0;
    let time = Math.random() * 100;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = Math.ceil(rows * cellHeight);
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      cols = Math.max(1, Math.floor(width / cellWidth));
      heat = new Float32Array(cols * rows);
    };

    const fuel = (column: number) => {
      // Drifting sum of sines → a handful of ignition points that wander slowly.
      const wave =
        Math.sin(column * 0.21 + time * 0.9) +
        Math.sin(column * 0.057 - time * 0.55) +
        Math.sin(column * 0.43 + time * 1.7) * 0.5;
      return Math.max(0, (wave / 2.5 + 1 - 2 * (1 - density) * 0.5 - 0.4) * 2.2);
    };

    const step = () => {
      time += 0.05;
      const last = (rows - 1) * cols;
      for (let column = 0; column < cols; column++) {
        heat[last + column] = Math.min(1, fuel(column) * (0.55 + Math.random() * 0.6));
      }
      for (let row = 0; row < rows - 1; row++) {
        for (let column = 0; column < cols; column++) {
          const below = (row + 1) * cols;
          const left = heat[below + Math.max(0, column - 1)];
          const centre = heat[below + column];
          const right = heat[below + Math.min(cols - 1, column + 1)];
          const twoBelow = row + 2 < rows ? heat[(row + 2) * cols + column] : centre;
          const averaged = (left + centre * 2 + right + twoBelow) / 5;
          heat[row * cols + column] = Math.max(0, averaged - (0.052 + Math.random() * 0.05));
        }
      }
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.font = `${fontSize}px "DM Mono", monospace`;
      context.textBaseline = "top";
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < cols; column++) {
          const value = heat[row * cols + column];
          if (value < 0.06) continue;
          const glyph = RAMP[Math.min(RAMP.length - 1, Math.floor(value * RAMP.length))];
          if (glyph === " ") continue;
          // Hot core is pale lime-white, edges fall back to the signal lime.
          context.fillStyle =
            value > 0.72
              ? `rgba(240, 255, 200, ${Math.min(1, value)})`
              : value > 0.38
                ? `rgba(217, 255, 145, ${0.35 + value * 0.6})`
                : `rgba(184, 242, 58, ${0.12 + value * 0.9})`;
          context.fillText(glyph, column * cellWidth, row * cellHeight);
        }
      }
    };

    const loop = (now: number) => {
      frame = window.requestAnimationFrame(loop);
      if (!visible || now - lastTick < 66) return; // ~15fps, like a terminal
      lastTick = now;
      step();
      draw();
    };

    resize();
    for (let warmup = 0; warmup < rows * 3; warmup++) step();
    draw();

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(canvas);
    window.addEventListener("resize", resize);
    if (!reduceMotion) frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [rows, density]);

  return <canvas ref={canvasRef} className={`ascii-flame ${className}`} aria-hidden="true" />;
}
