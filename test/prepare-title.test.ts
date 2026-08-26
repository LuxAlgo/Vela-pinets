import { describe, it, expect } from 'vitest';
import { preparePine } from '../src/pinets/runtime';

/**
 * The declaration title is parsed STATICALLY at prepare (no execution has happened
 * yet), and Vela's loading-legend placeholder shows exactly this value while the
 * script computes — so every declaration shape a real script uses must resolve to
 * its actual title, never the generic "Indicator" fallback.
 */

const title = (source: string): string => preparePine(source, 'title-probe').meta.title;

describe('preparePine declaration title', () => {
    it('positional string, double quotes', () => {
        expect(title('//@version=5\nindicator("Gator Oscillator", overlay=true)\nplot(close)\n')).toBe('Gator Oscillator');
    });

    it('positional string, single quotes', () => {
        expect(title("//@version=5\nindicator('Volume Delta')\nplot(close)\n")).toBe('Volume Delta');
    });

    it('named title argument', () => {
        expect(title('//@version=5\nindicator(title = "Value Area Reversion Signals", overlay = false)\nplot(close)\n')).toBe('Value Area Reversion Signals');
    });

    it('named title argument, single quotes, no spaces', () => {
        expect(title("//@version=5\nindicator(title='Session Sweep')\nplot(close)\n")).toBe('Session Sweep');
    });

    it('apostrophe inside a double-quoted title', () => {
        expect(title('//@version=5\nindicator("Trader\'s Dynamic Index")\nplot(close)\n')).toBe("Trader's Dynamic Index");
    });

    it('escaped quote inside the title is unescaped', () => {
        expect(title('//@version=5\nindicator("The \\"Big\\" Level")\nplot(close)\n')).toBe('The "Big" Level');
    });

    it('strategy() declaration, named form', () => {
        expect(title('//@version=5\nstrategy(title = "Breakout Backtest")\nplot(close)\n')).toBe('Breakout Backtest');
    });

    it('a commented-out declaration above the real one never wins', () => {
        expect(title('//@version=5\n// indicator("Old Name")\nindicator(title = "New Name")\nplot(close)\n')).toBe('New Name');
    });

    it('falls back to "Indicator" when no literal title is declared', () => {
        expect(title('//@version=5\nindicator(overlay = true)\nplot(close)\n')).toBe('Indicator');
    });
});
