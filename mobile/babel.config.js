// Babel config for the med-consult phones.
//
// The BigInt transform is the load-bearing part. We run on JSC (see app.json), and Android's JSC has
// no native BigInt. Our money code is all BigInt — base-unit prices, voucher `cumulative` totals,
// channel deposits — so without this, any screen that touches a price throws at runtime.
//
// Note the split of responsibilities that follows from this: the ESCROW VOUCHER IS SIGNED IN THE BARE
// WORKLET, not here. Bare has a real BigInt, ethers v6 requires a real BigInt (it will not accept a
// JSBI shim), and hyperswarm already lives in the worklet. React Native stays UI-only and never does
// arithmetic on money — it receives already-formatted strings. See worklets/consult-worklet.mjs.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Rewrites BigInt literals/operators to JSBI calls so display-side formatting cannot crash.
      'transform-bigint-to-jsbi',
    ],
  };
};
