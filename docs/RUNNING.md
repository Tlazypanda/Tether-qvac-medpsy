# Running MedConsult — desktop and mobile

From a clean checkout to a working consult, for both targets. If you only read one thing: the
**health worker's device needs a GPU and ~10 GB free**, the asker's device needs neither, and **peer
discovery needs a real LAN** — see [Troubleshooting](#troubleshooting) before you blame the code.

**Verification legend.** Steps are marked with what was actually exercised:

- ✅ **verified** — actually run, output observed
- ⚠️ **unverified** — written from the code and docs, not yet run end to end

The full desktop loop (discovery → escrow channel → MedPsy draft → human approval/rejection →
voucher → answer) is ✅ **verified with both roles on one machine.** Two physically separate devices
and the whole `mobile/` port are still ⚠️.

---

## 0. Prerequisites

| | Asker device | Health worker device |
|---|---|---|
| GPU | not needed | **required** — NVIDIA+Vulkan, or Apple Silicon+Metal |
| Free disk | ~1 GB | **~10 GB** (MedPsy-4B cache in `~/.qvac`) |
| Model | **none, by design** | QVAC MedPsy-4B (~2.7 GB, downloaded once) |
| Node.js | ≥ 22 | ≥ 22 |

**Use Node 22 LTS if you can.** ✅ Node 23 runs the engine fine, but Hardhat prints
`WARNING: You are currently using Node.js v23.6.0, which is not supported by Hardhat` on every
contracts command. It works; it's just noise you don't want on shoot day.

Both devices need `git` and a **testnet** wallet. Real funds are never involved.

---

## 1. Install

```bash
git clone <your fork url> qvac-medconsult
cd qvac-medconsult
npm install          # also compiles native modules for your platform
```

**If `npm install` fails with `ENOTEMPTY … rename … bare-runtime`** — a known npm failure when a
previous install was interrupted, and it leaves `@qvac/sdk` half-installed so every import fails
typecheck. Fix: ✅

```bash
rm -rf node_modules/bare-runtime node_modules/.bare-runtime-*
npm install
```

Confirm the SDK and the model constant are really there: ✅

```bash
npx tsc --noEmit     # must be silent
node -e "const s=require('@qvac/sdk'); console.log('MedPsy:', !!s.HEALTHCARE_4B_MEDICAL_Q4_K_M)"
```

Both must succeed before anything else. `MedPsy: true` means the registry constant (pinned commit +
sha256, so every device fetches byte-identical weights) resolved; it needs `@qvac/sdk >= 0.16.0`.

---

## 2. Pick a settlement chain

Two options. **Start with the local chain** — no faucet, no waiting, and the whole approval loop is
exercised identically.

### Option A — local Hardhat chain (recommended for development) ✅

Terminal 1, leave it running:

```bash
cd contracts && npx hardhat node
```

Terminal 2, once:

```bash
cd contracts && npx hardhat run scripts/deploy-local.ts --network localhost
```

It deploys MockUSDT + ConduitEscrow, funds the asker (account 0) with 1,000 test USD₮ and both roles
with gas, then **prints the exact `.env` block to paste**. Addresses are deterministic, so they match
the committed `.env.example` local block. ✅ Verified: deploys to
`0xe7f1725E…` (escrow) and `0x5FbDB231…` (token) on chain `31337`.

### Option B — Sepolia testnet

Use the addresses in the [root README](../README.md#contract-addresses-sepolia), then fund the
**asker** wallet with Sepolia ETH (gas) + test USD₮ from the listed faucets. Note that opening the
escrow channel is an on-chain transaction — it needs internet, so do it **before** any airplane-mode
filming.

Either way:

```bash
cp .env.example .env    # then uncomment the block for your chosen chain
```

---

## 3. Benchmark the health worker's device ✅

On the device that will serve consults:

```bash
npm run bench
```

Writes `bench-profile.json`. Check it picked the right model and found the GPU:

```json
{ "backend": "gpu", "topSellable": "HEALTHCARE_4B_MEDICAL_Q4_K_M", "models": [ { "tps": 25.6 } ] }
```

If `backend` is not `gpu`, stop and fix that first — MedPsy-4B on CPU is too slow to film. The seller
refuses to advertise a non-MedPsy model even if a stale profile picks one, so a leftover upstream
profile shows up as a warning rather than a wrong model on a medical topic.

---

## 4. Pre-download the model

First load pulls ~2.7 GB. Do it on Wi-Fi, once, before you need it:

```bash
npm run sell        # wait for "model ready", then Ctrl-C
```

✅ Verified: ~4 s to load from cache afterwards (vs minutes cold), `backend: gpu`, 10–26 tok/s.

---

## 5. Desktop — the consult loop

### Discovery: choose public DHT or LAN-local

Upstream joins the **public** Holepunch DHT, which needs internet. For an offline demo, run a
LAN-local bootstrap on any device on the shared Wi-Fi: ✅

```bash
npm run bootstrap
```

It prints the address to hand to both roles, e.g. `MEDCONSULT_BOOTSTRAP=192.168.1.50:49737`. **If it
warns that it fell back to loopback, fix your network before continuing** — it will tell you which
interfaces it skipped and why. Leave `MEDCONSULT_BOOTSTRAP` unset to use the public DHT instead.

### Two machines (the real demo) ⚠️

```bash
# Device A — health worker
MEDCONSULT_BOOTSTRAP=<ip>:49737 npm run sell

# Device B — asker
MEDCONSULT_BOOTSTRAP=<ip>:49737 CONSULT="My 3-year-old has had a fever of 39C for two days and is pulling at her right ear." npm run ask
```

✅ The **entire flow** — discovery, escrow channel open, MedPsy draft, human approval, voucher
settlement, answer delivery — is verified with both roles on one machine over a LAN-local DHT.
⚠️ Two *physically separate* devices are still unverified: it needs a real private-LAN address on
both, which the machine this was developed on does not have.

### Then: approve on the health worker's device

Open **`http://127.0.0.1:8799`**. You'll see the consult arrive, MedPsy stream a draft token by
token, and then the draft **park on an amber `AWAITING HUMAN REVIEW` banner**. Nothing has been sent.
Edit the text if you want, then tap **Approve & Send** — the answer is delivered and the payment
voucher is signed in the same step — or **Reject**, in which case nothing is delivered and nothing is
charged.

The screen binds to loopback on purpose: it can release a medical answer and authorise a payment. To
review from a phone on the same LAN, opt in explicitly:

```bash
HW_UI_HOST=0.0.0.0 HW_UI_PORT=8799 npm run sell
```

### Both roles on one machine ✅

Same as above in two terminals, with `npm run bootstrap` on loopback. The asker is account 0 and the
health worker account 1 of the same mnemonic, so they are distinct wallets. This is the configuration
everything below was verified in.

### Web UI instead of the CLI ⚠️

```bash
npm run app:install     # once
npm run start           # build + serve → http://localhost:8788
```

---

## 6. Check the proof

Each role writes its own JSONL log (both gitignored):

```bash
cat AUDIT_LOG.health-worker.jsonl
cat AUDIT_LOG.asker.jsonl
```

What to look for:

| Field | Means | Status |
|---|---|---|
| `"cloud_bytes": 0` | nothing went to a cloud | ✅ observed |
| `"backend": "gpu"` | inference really ran on-device | ✅ observed |
| `"approved_by_human": true` | a person released this answer | ✅ observed |
| `"edited_by_human": true` | they changed the wording before sending | ✅ observed |
| `"review_ms"` | how long they actually spent reading it | ✅ observed |
| `"outcome": "rejected_by_human"` | the reject path — never charged | ✅ observed |

A real captured session is committed as
[`AUDIT_LOG.consult-sample.jsonl`](../AUDIT_LOG.consult-sample.jsonl) — three consults from one run,
covering all three outcomes:

```
approved=True  edited=True  review_ms=38693 backend=gpu  cloud_bytes=0 outcome=delivered
approved=False edited=None  review_ms=3767  backend=None cloud_bytes=0 outcome=rejected_by_human
approved=True  edited=False review_ms=7392  backend=gpu  cloud_bytes=0 outcome=delivered
```

That is the screenshot artifact: `approved_by_human` next to a `review_ms` in the thousands is the
evidence a person actually read the draft, and the middle line is a health worker declining to send —
never charged.

**Settlement** is a separate on-chain step. The health worker batches vouchers and only claims once
unclaimed earnings reach 0.05 USD₮, so a handful of consults may not trigger one. To see the full
money lifecycle end to end (open → off-chain vouchers → claim → settle + close):

```bash
npm run escrow-demo     # ✅ verified on the local chain: "spent = earned · channel closed · PASS"
npm run audit           # ✅ model lifecycle + inference only — no chain, no peer
```

---

## 7. Mobile ⚠️

**Status: scaffolded, never run on a device.** QVAC does not run on simulators or emulators (a
`llama.cpp` limitation) and no physical device was available. Full architecture and the gap list are
in [`mobile/README.md`](../mobile/README.md). Expect to fix things on the first real run.

Two physical phones. Do steps 1–4 above on a laptop first (the escrow channel and the model download
both want internet).

```bash
cd mobile
npm install
cp mobile-config.example.json mobile-config.json    # fill in PER DEVICE — testnet keys only
npm run bundle:worklets                             # pack the Bare worklet (ios + android)
npx expo prebuild                                   # generates ios/ + android/
npm run ios                                         # or: npm run android
```

Both `run` scripts pass `--device`. **A simulator will not work.**

`mobile-config.json` holds this device's testnet wallet, the `bootstrap` address from
`npm run bootstrap`, and (health worker only) the `offer` it advertises. It is gitignored because it
contains a private key.

On first launch, pick the role. The health worker's phone downloads MedPsy-4B once — on Wi-Fi, before
airplane mode.

Re-run `npm run bundle:worklets` after **any** edit to `worklets/consult-worklet.mjs`. Metro cannot
see inside a packed bundle, so a stale one silently keeps running the old P2P code.

---

## 8. Filming

For the shot itself, follow the phased
[shoot-day checklist](../README.md#reproducing-the-demo-shoot-day-checklist) in the root README. Its
whole point is that **everything needing the internet happens in phase 1**, before airplane mode —
including opening the escrow channel — so nothing claimed on camera is hidden or untrue.

---

## Troubleshooting

### `[asker] no health worker found in 30s`

Peer discovery failed. In order of likelihood:

1. **Too few nodes in your local DHT.** This was the real blocker, and it is now fixed in
   `npm run bootstrap` — but it is worth understanding, because the symptom is so misleading. hyperdht
   does not connect peers directly; it coordinates through *other* DHT nodes, which must be
   non-ephemeral and non-firewalled. A single `DHT.bootstrapper()` gives it nothing to relay through,
   so the handshake half-completes: the client fires `connection`, the **server never does**, and zero
   offer bytes move. It looks exactly like a NAT/firewall problem and is not one.

   Measured on loopback: 1, 2 and 3 nodes all fail; **5 and 10 work.** `npm run bootstrap` now starts
   10 and refuses fewer than 5. If you rolled your own bootstrap, that is the first thing to check.

2. **The two roles are on different bootstraps.** Both must get the *same*
   `MEDCONSULT_BOOTSTRAP`, or both must omit it. Each prints its mode at startup —
   `discovery: LAN-local DHT via … (no internet needed)` vs `public Holepunch DHT (needs internet)`.
   Read those two lines before debugging anything else.

3. **`npm run sell` isn't actually up.** It must have printed `model ready`.

4. **Your network is not a LAN** — this only matters for a *two-device* demo. On macOS, `en0` may be
   `192.0.0.2/32` with `NOARP`, which is iPhone USB tethering, not a LAN: a `/32` has no subnet, so no
   other device can route to it. Check with:

   ```bash
   ifconfig | grep -E "^[a-z0-9]+:|inet " | grep -v inet6
   ```

   You want `192.168.x.x`, `10.x.x.x` or `172.16–31.x.x`. `npm run bootstrap` already refuses to bind
   a non-routable address and tells you which interfaces it skipped, falling back to loopback — which
   is fine for both roles on one machine (✅ verified) but cannot serve a second device.

### `npm install` → `ENOTEMPTY … bare-runtime`

See [step 1](#1-install). Stale directory from an interrupted install.

### `Cannot find module '@qvac/sdk'` from `tsc`

The SDK isn't installed — same cause as above. `npm install` and re-check.

### The approval screen is empty / unreachable

It binds to `127.0.0.1` by default. From the same machine use `http://127.0.0.1:8799`; from another
device on the LAN you must opt in with `HW_UI_HOST=0.0.0.0`.

### Model download is slow or stalls

It's ~2.7 GB from Hugging Face. Do it once on good Wi-Fi ([step 4](#4-pre-download-the-model)). The
cache lives in `~/.qvac/models/`; `du -sh ~/.qvac` shows progress.

### Hardhat warns about the Node version

Cosmetic. Use Node 22 LTS to silence it.

### The footer says the wrong chain

It reads the chain you're actually connected to (`testnetNotice(chainId)`), so if it says
"a local Hardhat chain" while you expected Sepolia, your `.env` is still pointed at `31337`.

### Repeated `npm run ask` runs don't accumulate earnings

Known issue, not yet fixed. Each `npm run ask` is a fresh process: it re-reads the channel and starts
its voucher `cumulative` from the amount already *claimed* on-chain. The health worker resets its own
session the same way on `sessionOpen`. So six one-shot CLI consults each draw a voucher for the same
`cumulative` of 10000 rather than climbing 10000 → 60000, and the health worker can only ever claim
the one payment — which also means the 0.05 USD₮ claim threshold never trips from CLI runs alone.

It does not affect a long-lived asker (the desktop app or a phone), where `cumulative` climbs
correctly within the session, and no voucher is ever double-spent — the effect is under-collection,
not over-charging. Fixing it properly means persisting per-channel cumulative across processes.
Use `npm run escrow-demo` to exercise claim/settle in the meantime.

### Reject path shows as an error on the asker

It shouldn't — a human declining is a legitimate outcome. The asker should read *"Health worker did
not approve"*, not a network error. If you see otherwise, that's a bug worth filing.
