/**
 * Where things sit on the Overview's sonar: problem pods as blips on the
 * inner rings (errors closest, the rest further out), the healthy fleet as
 * faint dots on the outer ring. Positions come from the names, so a pod
 * keeps its bearing across updates and the picture only moves when the
 * cluster does.
 */

export interface Blip {
  key: string;
  x: number;
  y: number;
  /** "error" on the inner ring, "warn" on the middle one. */
  tone: "error" | "warn";
}

/** Ring radii, as fractions of the scope's radius. */
export const RINGS = [0.36, 0.64, 0.9] as const;

/** FNV-1a: a stable bearing for a name. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function polar(r: number, turn: number): { x: number; y: number } {
  const a = turn * Math.PI * 2 - Math.PI / 2;
  return { x: +(r * Math.cos(a)).toFixed(2), y: +(r * Math.sin(a)).toFixed(2) };
}

/** A problem is an error when its reason is its status (CrashLoopBackOff, Error, …). */
export function problemTone(p: { reason: string; status: string }): Blip["tone"] {
  return p.reason === p.status && p.status !== "Pending" ? "error" : "warn";
}

/** Blips for problem pods, on a scope of radius `r`. */
export function blips(
  problems: { namespace: string; name: string; reason: string; status: string }[],
  r: number,
): Blip[] {
  return problems.map((p) => {
    const key = `${p.namespace}/${p.name}`;
    const tone = problemTone(p);
    const h = hash(key);
    // A little jitter off the ring, so close bearings don't stack.
    const ring = RINGS[tone === "error" ? 0 : 1] + ((h >>> 24) / 255 - 0.5) * 0.12;
    return { key, tone, ...polar(r * ring, (h % 3600) / 3600) };
  });
}

/**
 * The healthy fleet: up to `max` dots on the outer ring, spread by the
 * golden angle so any count looks even.
 */
export function fleet(count: number, r: number, max = 48): { x: number; y: number }[] {
  const n = Math.min(count, max);
  const out = [];
  for (let i = 0; i < n; i++) {
    const wobble = ((i * 7) % 5) / 5 - 0.4;
    out.push(polar(r * (RINGS[2] + wobble * 0.05), (i * 0.618034) % 1));
  }
  return out;
}
