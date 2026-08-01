import { describe, expect, it } from 'vitest';

// The color sources of truth. Vela's semantic palette arrives through
// `@luxalgo/vela/plugin`; the only hexes THIS package may state are the script
// language's own color constants. Everything else must import, never restate.
const SANCTIONED = [
    'src/pinets/inputsMeta.ts', // the script language's own named color constants
];

/** Escape hatch for a color that is deliberately fixed and belongs nowhere else — the line
 *  must say why with this marker. */
const EXEMPT_MARKER = 'palette-exempt';

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** Grayscale hexes (black, white, and the grays between) carry no palette meaning — a
 *  contrast fallback of `#000000` is not a stray brand color. */
function isGrayscale(hex: string): boolean {
    const h = hex.slice(1);
    const ch = h.length < 6 ? [...h.slice(0, 3)].map((c) => c + c) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
    return ch.length === 3 && ch[0] === ch[1] && ch[1] === ch[2];
}

type RawGlob = (pattern: string, options: { query: string; import: string; eager: true }) => Record<string, string>;

const sources = Object.entries(
    (import.meta as unknown as { glob: RawGlob }).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }),
).map(([path, text]) => [path.replace(/^\.\.\//, ''), text] as const);

describe('color literals', () => {
    it('stay in the sanctioned palette modules', () => {
        const strays: string[] = [];
        for (const [file, text] of sources) {
            if (SANCTIONED.includes(file)) continue;
            text.split('\n').forEach((line, i) => {
                if (line.includes(EXEMPT_MARKER)) return;
                for (const hex of line.match(HEX) ?? []) {
                    if (isGrayscale(hex)) continue;
                    strays.push(`${file}:${i + 1} ${hex}`);
                }
            });
        }
        expect(strays, `import from '@luxalgo/vela/plugin' (the semantic palette) instead, or mark the line \`${EXEMPT_MARKER}: reason\``).toEqual([]);
    });

    it('scans the real source (so a green result means something)', () => {
        expect(sources.length).toBeGreaterThan(10);
        expect(sources.find(([f]) => f === 'src/pinets/inputsMeta.ts')?.[1]).toMatch(HEX);
        expect(isGrayscale('#2962ff')).toBe(false);
        expect(isGrayscale('#fff')).toBe(true);
        expect(isGrayscale('#1e293b')).toBe(false);
    });
});
