// Browser global build (window.VelaPinets) — the engines as one self-contained IIFE
// (pinets + the inlined worker bundled) for script-tag usage NEXT TO `vela.global.js`:
// `@luxalgo/vela` imports resolve to the page's `window.Vela`, never a second copy.
export * from './index';
