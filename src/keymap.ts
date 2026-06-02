// src/keymap.ts
/** One RDP keyboard event. Either a hardware scancode (set-1 make code) or a Unicode code point. */
export interface KeyEvent {
  scancode?: number;
  unicode?: number;
  down: boolean;
}

const MODIFIERS: Record<string, number> = {
  ctrl: 0x1d, control: 0x1d,
  alt: 0x38,
  shift: 0x2a,
  win: 0xe05b, meta: 0xe05b, // extended (E0) prefix encoded in the high byte
};

// Set-1 make codes for the keys we expose. Extended keys carry 0xE0 in the high byte.
const KEYS: Record<string, number> = {
  enter: 0x1c, esc: 0x01, escape: 0x01, tab: 0x0f, space: 0x39, backspace: 0x0e,
  delete: 0xe053, del: 0xe053, home: 0xe047, end: 0xe04f,
  pageup: 0xe049, pagedown: 0xe051, insert: 0xe052,
  up: 0xe048, down: 0xe050, left: 0xe04b, right: 0xe04d,
  a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23,
  i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32, n: 0x31, o: 0x18, p: 0x19,
  q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d,
  y: 0x15, z: 0x2c,
  "0": 0x0b, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06,
  "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41,
  f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
};

/** Parse a chord like "Ctrl+Shift+Esc" into press-modifiers → press/release key → release-modifiers. */
export function chordToEvents(chord: string): KeyEvent[] {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) throw new Error(`empty chord: "${chord}"`);
  const mods: number[] = [];
  let key: number | undefined;
  for (const p of parts) {
    if (p in MODIFIERS) mods.push(MODIFIERS[p]);
    else if (p in KEYS) {
      if (key !== undefined) throw new Error(`chord has more than one non-modifier key: "${chord}"`);
      key = KEYS[p];
    } else throw new Error(`unknown key "${p}" in chord "${chord}"`);
  }
  if (key === undefined) throw new Error(`chord "${chord}" has no non-modifier key`);
  const ev: KeyEvent[] = [];
  for (const m of mods) ev.push({ scancode: m, down: true });
  ev.push({ scancode: key, down: true }, { scancode: key, down: false });
  for (const m of [...mods].reverse()) ev.push({ scancode: m, down: false });
  return ev;
}

/** Turn arbitrary text into Unicode key events (handles any character via RDP's unicode event). */
export function textToEvents(text: string): KeyEvent[] {
  const ev: KeyEvent[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    ev.push({ unicode: cp, down: true }, { unicode: cp, down: false });
  }
  return ev;
}
