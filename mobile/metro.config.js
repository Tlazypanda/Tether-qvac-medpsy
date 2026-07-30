// Metro config.
//
// Two things Metro does not do by default and that this port needs:
//
// 1. `.mjs` / `.cjs` source extensions — the Bare worklet is authored as .mjs and `bare-pack` emits a
//    .bundle.js in CJS format. Metro must be willing to resolve both.
// 2. The pre-built worklet bundles are loaded as TEXT, not as modules — `Worklet.start()` takes the
//    bundle's source string. They are registered as an asset extension so `require()` hands us the
//    contents instead of trying to parse ~2 MB of packed Bare code as an app module.
//
// The worklet bundles are build products of `npm run bundle:worklets`. Rebuild them whenever
// worklets/consult-worklet.mjs changes — Metro's fast refresh does NOT see inside a packed bundle,
// so a stale bundle silently keeps running the old P2P code.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'mjs', 'cjs'])];

// Let the packed worklet bundles through as inlined text.
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, 'bundle'])];

module.exports = config;
