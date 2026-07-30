# MedConsult — Expo/Bare mobile client

The phone half of the med-consult demo: **Asker** and **Health Worker** as a runtime role choice in one
app, talking the same wire protocol as the desktop nodes in `src/node/`.

> ## ⚠ Status: scaffolded, NOT yet verified on a device
>
> Every file here was written against QVAC's documented Expo path and [Leash](https://github.com/danielAsaboro/Leash)'s
> working `apps/mobile` as the reference implementation, but **none of it has been run on a phone.**
> QVAC does not run on simulators or emulators (a `llama.cpp` limitation), and no physical device was
> available. Treat the checklist below as the first run, not a regression test — expect to fix things.
>
> What *is* verified (on desktop, macOS/arm64): MedPsy-4B loads from the `@qvac/sdk` registry constant
> in ~4 s and drafts on the `gpu` backend with `cloud_bytes: 0`; the approval gate, protocol and
> disclaimer all work end to end in-process. What is **not** verified anywhere yet: peer discovery
> between two devices (see the root README's networking note), and everything in this directory.

## How it is put together

The load-bearing decision: **anything touching the network or money runs inside the Bare worklet, and
React Native is UI-only.**

| | Runs in | Why there |
|---|---|---|
| Hyperswarm, consult protocol, EIP-712 voucher signing | **Bare worklet** (`worklets/consult-worklet.mjs`) | RN has no UDP sockets, no real `Buffer`, and on JSC no `BigInt`. `ethers` v6 needs a genuine `BigInt` and rejects a JSBI shim. Bare has all three. |
| MedPsy-4B inference (health worker only) | **React Native**, via `@qvac/sdk` | The SDK resolves its `#rpc` import to `expo-rpc-client` and drives its *own* Bare worklet. Loading the model in our P2P worklet would put two copies of 2.7 GB in one process. |
| UI, approval state machine | **React Native** | `src/useMedPsy.ts` is the mobile counterpart of `src/sell/consult.ts`, which was written transport-agnostic for exactly this. |

Bridge is `BareKit.IPC` with newline-delimited JSON, same framing as the wire protocol
(`src/core/protocol.ts`) so a phone and a laptop are interchangeable on either side of a consult.

```
worklets/consult-worklet.mjs   Hyperswarm + protocol + voucher signing (packed by bare-pack)
src/worklet-bridge.ts          RN↔worklet IPC, typed events
src/useMedPsy.ts               MedPsy drafting + approval state machine
src/medconsult.ts              constants mirrored from src/core/medconsult.ts — KEEP IN SYNC
src/screens/AskerScreen.tsx    ask → wait → answer + disclaimer
src/screens/HealthWorkerScreen.tsx   draft → review banner → edit → Approve/Reject
polyfills.ts                   JSC gap-fillers; imported FIRST from index.ts
```

## Gotchas already accounted for

Each of these is a real failure mode, not a precaution:

- **JSC, not Hermes** (`app.json` → `jsEngine: "jsc"`). This is what Leash ships and what the QVAC
  Bare bridge is exercised against. On Android you additionally need a plugin to force JSC, since RN
  defaults to Hermes there — Leash carries `./plugins/with-android-jsc` for this. **Not yet written
  here** (see Known gaps).
- **`BigInt` on Android JSC does not exist.** `babel.config.js` applies
  `transform-bigint-to-jsbi`, and `polyfills.ts` installs a JSBI-backed shim. Display-side only —
  hence signing in the worklet.
- **iOS blocks local-network discovery** until the user grants it. Without
  `NSLocalNetworkUsageDescription` + `NSAllowsLocalNetworking` the airplane-mode LAN demo finds no
  peer at all, and it looks exactly like a broken DHT.
- **`minSdkVersion: 29`** is required by `@qvac/sdk` on Android.
- **Worklet bundles are build products.** Metro cannot see inside them, so a stale bundle silently
  keeps running old P2P code. Re-run `npm run bundle:worklets` after touching the `.mjs`.
- **Import order in `index.ts` is load-bearing** — polyfills before anything that reaches the SDK.

## First run on real devices

> Prefer the full walkthrough in [`docs/RUNNING.md`](../docs/RUNNING.md) (§7 covers mobile, and §1–4
> the laptop-side prep you need first). The short version follows.

Two phones, both physical. **A = health worker** (needs GPU + ~2.7 GB free), **B = asker**.

```bash
cd mobile
npm install
cp mobile-config.example.json mobile-config.json   # fill in per device — testnet keys only
npm run bundle:worklets                            # pack the Bare worklet for both targets
npx expo prebuild                                  # generates ios/ + android/
npm run ios        # or: npm run android    (both --device; a simulator will NOT work)
```

Then follow **Phase 1** of the root README's
[shoot-day checklist](../README.md#reproducing-the-demo-shoot-day-checklist) — in particular, open the
escrow channel and pre-download the model *while still online*, then start `npm run bootstrap` on a
laptop on the same Wi-Fi and put its address in each phone's `mobile-config.json`.

On first launch pick the role. The health worker's phone downloads MedPsy-4B once (~2.7 GB — do this
on Wi-Fi, before airplane mode).

## Known gaps

Ordered by how likely they are to bite:

1. **`with-android-jsc` plugin is missing.** Android needs an Expo config plugin to force JSC over
   Hermes; Leash has one. Until it exists, Android will build with Hermes and the Bare bridge is
   likely to misbehave. iOS should be fine via `jsEngine`.
2. **Voucher signing is unproven.** `payAndCollect()` in the worklet mirrors the desktop draw step,
   but whether `ethers` v6 packs cleanly under `bare-pack` is untested. If it does not, the fallback
   is to sign with `bare-crypto` secp256k1 directly against the EIP-712 digest.
3. **Channel opening is intentionally absent.** Opening a channel is an on-chain transaction and must
   happen before airplane mode; the phone assumes an already-open channel and only draws against it.
   `epoch` therefore has to be filled into `mobile-config.json` by hand.
4. **No audit log on device.** The desktop nodes write JSONL via `src/core/audit.ts`; the phones do
   not yet. The `approved_by_human` / `review_ms` evidence currently only exists on desktop runs.
5. **No QR pairing.** Leash pairs devices by scanning a QR of the peer's public key, which would be
   far more robust offline than topic discovery. Worth stealing if discovery proves flaky.
6. **Constants are duplicated** in `src/medconsult.ts` and the worklet's topic. If they drift, phones
   and laptops stop meeting.

## Licence

[Apache-2.0](../LICENSE), as a fork of [Conduit](https://github.com/Conduit-Organization/conduit).
The Expo/Bare approach here follows [Leash](https://github.com/danielAsaboro/Leash) (also Apache-2.0)
as a reference for running the Holepunch stack under Expo.

**Not medical advice.** Answers are an AI-assisted draft reviewed by a human health worker before
sending — not a substitute for professional medical care in an emergency.
