<p align="center">
  <img src="./docs/assets/conduit-banner.svg" alt="Conduit — serverless P2P inference market" width="560">
</p>

<p align="center">
  <b>Offline, peer-to-peer medical consults — QVAC MedPsy-4B drafts on a health worker's device,
  a human approves, and a testnet USD₮ voucher settles P2P with no internet.</b>
</p>

<p align="center">
  <i>A fork of <a href="https://github.com/Conduit-Organization/conduit">Conduit</a> (Apache-2.0).
  See <a href="#what-changed-vs-upstream-conduit">what changed vs upstream</a>.</i>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-2be3a8"></a>
  <img alt="Network" src="https://img.shields.io/badge/network-Sepolia%20testnet-ffc44d">
  <img alt="AI" src="https://img.shields.io/badge/AI-100%25%20on--device%20via%20QVAC-2be3a8">
  <img alt="Cloud bytes" src="https://img.shields.io/badge/prompt%20bytes%20to%20cloud-0-2be3a8">
  <a href="https://www.conduitt.xyz"><img alt="Site" src="https://img.shields.io/badge/site-conduitt.xyz-8a9aa6"></a>
</p>

---

Two roles, two devices, no internet.

- **Asker** — a community member or under-resourced health worker whose device carries **no medical
  model at all**. They send a health question over a local peer-to-peer link.
- **Health worker** — carries **QVAC MedPsy-4B** and fields consults. Their device drafts a clinical
  response (severity read + management plan) locally in seconds. The health worker **reviews the
  draft, can edit it, and taps Approve & Send** — nothing goes out unsupervised. On approval the
  answer is delivered and a signed micropayment in test USD₮ settles peer-to-peer as an off-chain
  voucher against a pre-funded escrow channel, so that moment needs no internet.

Model weights never move; only prompt-bytes-in / token-bytes-out cross the wire; **the cloud sees
nothing**. Every model runs fully on-device through the **QVAC runtime**.

> **Not medical advice.** Answers are an AI-assisted draft reviewed by a human health worker before
> sending — not a substitute for professional medical care in an emergency.

> **Testnet only.** Payments use test USD₮ on Ethereum Sepolia, or a throwaway local Hardhat chain —
> no real money moves, ever. A demonstration of the access-control + settlement primitive, not a
> live financial service.

> **The channel is the one step that touches the internet.** Opening (or topping up) the escrow
> channel is an on-chain transaction. It happens **visibly before** the airplane-mode moment; the
> consult, the draft, the approval and the voucher do not need a network at all. See the
> [shoot-day checklist](#reproducing-the-demo-shoot-day-checklist).

## Contents

- [**Running it, step by step** (`docs/RUNNING.md`)](./docs/RUNNING.md) — desktop + mobile, with troubleshooting
- [What changed vs upstream Conduit](#what-changed-vs-upstream-conduit)
- [How it works](#how-it-works)
- [Demo hardware](#demo-hardware)
- [Prerequisites](#prerequisites)
- [Setup (clean checkout)](#setup-clean-checkout)
- [Environment variables](#environment-variables)
- [Contract addresses (Sepolia)](#contract-addresses-sepolia)
- [Getting testnet funds](#getting-testnet-funds)
- [Running it](#running-it)
- [All commands](#all-commands)
- [Models](#models)
- [Audit log](#audit-log)
- [Remote APIs — the no-cloud guarantee](#remote-apis--the-no-cloud-guarantee)
- [Reproducing the demo (shoot-day checklist)](#reproducing-the-demo-shoot-day-checklist)
- [Repository layout](#repository-layout)
- [License](#license)

---

## What changed vs upstream Conduit

This fork keeps Conduit's hard infrastructure — Hyperswarm/Holepunch discovery, the `ConduitEscrow`
EIP-712 voucher channel, the capability prober, the reputation + freeloader-rejection handshake, and
the JSONL audit log — and retargets it at a single, narrower story. Nothing here was rebuilt from
scratch; attribution and the Apache-2.0 licence are intact.

| # | Change | Why |
|---|---|---|
| 1 | **Model swap** — serve only `HEALTHCARE_4B_MEDICAL_Q4_K_M` (QVAC MedPsy-4B, ~2.7 GB) instead of the general-purpose Qwen3 tiers. Uses the `@qvac/sdk` registry constant, which carries a pinned commit sha + sha256, so every device fetches byte-identical weights. Requires `@qvac/sdk >= 0.16.0`. | The demo is a medical consult, not general chat. The seller node now refuses to advertise a non-MedPsy model even if a stale `bench-profile.json` picks one. |
| 2 | **Routing simplified** — the asker has no model, so there is no local draft and no confidence router. Every consult goes straight to a paid health-worker peer. `SpendPolicy` (per-call cap + session budget) is kept unchanged. | Upstream escalates to a peer only when a local draft looks weak. Here the payment's reason to exist is compensating a human's time and expertise, not covering for a weak device. |
| 3 | **Human-approval gate (the main new feature)** — a consult is now a state machine: `queued → drafting → awaiting_review → approved \| rejected`. The draft parks on `awaiting_review` indefinitely and is **not sent anywhere** until a person decides. On approval the (possibly edited) answer is delivered **and** the voucher is signed in the same step; on rejection nothing is delivered and nothing is charged. | Unsupervised medical AI output is a real safety problem. Upstream's provider path returns inference automatically — there was no human in the loop to add. |
| 4 | **A UI for the provider role** — upstream's seller is headless (`npm run sell`), with the only UI on the buyer side. The seller now serves its own dependency-free approval screen (SSE-streamed draft tokens, edit box, Approve/Reject), bound to loopback by default since it can release an answer and authorise a payment. | A human-approval gate needs a human-facing surface on the device doing the approving, and it has to read clearly on camera. |
| 5 | **Rebrand + own DHT topic** — buyer/seller → Asker/Health Worker throughout; topic is `medconsult:demo:v1`, never upstream's live `conduit:market:v1`. | Keeps our testing off the live Conduit marketplace, and keeps real Conduit buyers away from a node that only speaks the consult protocol. |
| 6 | **Persistent medical disclaimer** — on the health worker's approval screen and inside the asker's answer bubble (so it cannot be scrolled away from the text it qualifies). | Mirrors QVAC MedPsy's own framing: an assistant, not a doctor. |
| 7 | **Offline discovery** (`src/core/swarm.ts`, `npm run bootstrap`) — optional LAN-local DHT bootstrap via `MEDCONSULT_BOOTSTRAP=host:port`. Unset leaves upstream's public-DHT behaviour unchanged. | Upstream's nodes bootstrap off the **public** Holepunch DHT, which needs the internet. This demo claims airplane mode, so discovery has to work with no route out. |
| 8 | **Local test chain** (`contracts/scripts/deploy-local.ts`) — deploy MockUSDT + ConduitEscrow to a throwaway Hardhat chain and fund both roles. | Upstream only ships a Sepolia deploy, so the full loop needed a faucet round trip. This makes the approval gate testable with no faucet and no real keys. |
| 9 | **Chain-aware testnet notice** — `testnetNotice(chainId)` names the chain actually in use. | The old constant hardcoded "on Sepolia"; reading that off a screen while connected to chain 31337 would be a false claim on camera. |
| 10 | **Audit log additions** — `approved_by_human`, `review_ms`, `draft_ms`, and a `rejected_by_human` outcome, alongside upstream's `cloud_bytes: 0` and backend fields. | This is the artifact that proves the run was not fully autonomous. |

**Still upstream, deliberately untouched:** the escrow contract and voucher scheme, the payment-gated
QVAC provider firewall, the prober, reputation, and the audit logger itself.

---

## How it works

One codebase runs both roles — **asker** and **health worker** is a runtime choice, not a separate
product. A node learns what it can serve by benchmarking its own hardware (the **capability prober**,
`npm run bench`).

The consult→answer path has five hops:

1. **Discover** — peers meet on a Hyperswarm/Holepunch DHT (topic `medconsult:demo:v1`) with NAT
   hole-punching. There is no server in the middle. The health worker advertises an offer (model +
   price + tps). Set `MEDCONSULT_BOOTSTRAP` to keep discovery on a LAN with no internet.
2. **Delegate** — the asker carries no model, so there is no local draft and no confidence router:
   every consult goes straight to a paid peer. A **SpendPolicy** (per-call cap + session budget)
   authorizes the spend; if it declines, nothing is sent.
3. **Pay** — the first consult opens an **escrow payment channel** (one on-chain deposit), then each
   answer settles **off-chain** with a signed **EIP-712 voucher** — no on-chain wait and no network at
   settlement time. The channel only touches the chain again when the health worker claims the balance.
4. **Draft** — the payment releases the health worker's **firewall-gated QVAC provider** pubkey and
   MedPsy-4B drafts a severity read + management plan **on the health worker's device**. The asker
   never sees the weights, the health worker never sees the asker's keys, and no prompt touches a cloud.
5. **Approve** — the draft **stops here** and waits on a human. The health worker reads it, edits it if
   needed, and taps **Approve & Send** (or **Reject**). Only on approval is the answer delivered and
   the voucher signed — in the same step. There is deliberately no timeout on human judgement.

A **freeloader** (no payment) is refused at the Noise handshake having transferred **0 bytes**. First-party
**reputation** (served/failed + EWMA tok/s) ranks peers in the marketplace.

For deeper architecture notes see [`docs/CONDUIT-ARCHITECTURE.md`](./docs/CONDUIT-ARCHITECTURE.md) and the
diagrams in [`docs/diagrams/`](./docs/diagrams/).

---

## Demo hardware

The demo runs across **two devices on the same local network** (a "freeloader" role is a separate
process + keypair on the asker's machine, not a third device). Both run the same codebase;
asker/health worker is a runtime flag.

| Role | Machine | CPU | GPU | RAM | Storage | OS |
|------|---------|-----|-----|-----|---------|-----|
| **Asker** (no model — agent + wallet only) | Linux laptop | AMD Ryzen 7 7435HS — 8 cores / 16 threads | NVIDIA GeForce RTX 4050 Laptop — 6 GB VRAM, Vulkan, driver 580.82 | 24 GB DDR5 | NVMe SSD | Pop!_OS 24.04 LTS, kernel 6.16 |
| **Health worker** (MedPsy-4B + approval screen) | MacBook Air (M5) | Apple M5 — Apple Silicon | Apple integrated GPU (Metal) | 16 GB unified memory | SSD (~10 GB free for the model cache) | macOS 15+ |

> The roles are **not** interchangeable here: only the health worker's device needs the GPU and the
> ~2.7 GB MedPsy-4B cache. The asker's device deliberately carries no model at all. Inference runs on
> the GPU (the audit log records `"backend":"gpu"`); MedPsy-4B Q4_K_M needs ~3 GB of unified memory.

> **Networking matters more than you'd think.** Both devices need a real private-LAN address. A USB
> tethering link (`192.0.0.2/32`, `NOARP` on macOS) is not a LAN and Holepunch cannot connect over it —
> discovery fails with a bare 30-second timeout. Verified the hard way; see step 1 of the
> [checklist](#reproducing-the-demo-shoot-day-checklist).

---

## Prerequisites

The two roles do **not** need the same machine:

| | Asker device | Health worker device |
|---|---|---|
| GPU | not needed | **required** — NVIDIA+Vulkan or Apple Silicon+Metal |
| Free disk | ~1 GB | **~10 GB** for the model cache (`~/.qvac`) |
| Model | **none, by design** | MedPsy-4B, ~2.7 GB, downloaded once |

- **Node.js ≥ 22** (prefer 22 LTS — Hardhat warns on 23, harmlessly but noisily)
- A **testnet** wallet, or the local Hardhat chain, which needs no faucet at all
- **A real LAN** for the two-device demo — see the networking note under [Demo hardware](#demo-hardware)
- `git`

---

## Setup (clean checkout)

> **📖 Step-by-step guide: [`docs/RUNNING.md`](./docs/RUNNING.md)** — desktop and mobile from zero,
> with a troubleshooting section for the failures that actually happen. Start there if anything below
> doesn't work first time.

```bash
# 1. Clone + install engine dependencies
git clone <your fork url> qvac-medconsult
cd qvac-medconsult
npm install                     # also compiles native modules for your platform

# 2. Verify the SDK + model constant resolved (must be silent, then print true)
npx tsc --noEmit
node -e "const s=require('@qvac/sdk'); console.log('MedPsy:', !!s.HEALTHCARE_4B_MEDICAL_Q4_K_M)"

# 3. Configure the environment — .env.example has a ready-made block for each chain option
cp .env.example .env

# 4. Either: a local chain, no faucet needed (see docs/RUNNING.md §2)
cd contracts && npx hardhat node                                    # terminal 1
cd contracts && npx hardhat run scripts/deploy-local.ts --network localhost   # terminal 2
#     Or:  fund the ASKER wallet (account 0) with Sepolia ETH + test USD₮

# 5. Benchmark the health worker's machine → bench-profile.json
npm run bench                   # confirm "backend": "gpu" and the MedPsy model

# 6. Pre-download the model once (~2.7 GB), then Ctrl-C
npm run sell                    # wait for "model ready"
```

> If `npm install` fails with `ENOTEMPTY … bare-runtime`, an earlier install was interrupted and
> `@qvac/sdk` is half-written. Fix:
> `rm -rf node_modules/bare-runtime node_modules/.bare-runtime-* && npm install`

---

## Environment variables

Copy `.env.example` → `.env` and fill in. Both roles read this file. **Testnet keys only — never commit a secret.**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `CONDUIT_WALLET_MNEMONIC` | ✅ | — | BIP-39 seed phrase (testnet). Account 0 = buyer, account 1 = seller earnings. |
| `CONDUIT_RPC_URL` | ✅ | `https://rpc.sepolia.org` | EVM **testnet RPC** — the only remote service, non-AI, settlement only. |
| `CONDUIT_CHAIN_ID` | ✅ | `11155111` | Sepolia chain id. |
| `CONDUIT_USDT_ADDRESS` | ✅ | — | Test USD₮ token contract (see below). |
| `CONDUIT_ESCROW` | — | `0` | `1` enables the instant escrow payment-channel path (recommended). |
| `CONDUIT_ESCROW_ADDRESS` | when escrow on | — | Deployed `ConduitEscrow` contract (see below). |
| `CONDUIT_SEED` | — | random | 64-hex seed for a deterministic Hyperswarm identity. |
| `CONDUIT_SELLER_MNEMONIC` | — | — | Run the seller from a different wallet than the buyer. |
| `CONDUIT_SELLER_MODEL` | — | prober's pick | Force the seller to serve a specific model. |
| `CONDUIT_VERIFY` | — | `0` | `1` adds a self-critique pass on confident local answers. |
| `PORT` | — | `8788` | Web/engine API port. |

> The packaged desktop app ships with escrow **on by default** and the contract address baked in — no
> `.env` needed for paid answers there.

---

## Contract addresses (Sepolia)

Network: **Ethereum Sepolia** · chain id **`11155111`**.

| Contract | Address | Explorer |
|----------|---------|----------|
| **ConduitEscrow** (payment channels) | `0x741BbE3B2d19E1aE965467280Cc2a442F3632Ee7` | [etherscan](https://sepolia.etherscan.io/address/0x741BbE3B2d19E1aE965467280Cc2a442F3632Ee7) |
| **Test USD₮** (ERC-20, 6 decimals) | `0xd077A400968890Eacc75cdc901F0356c943e4fDb` | [etherscan](https://sepolia.etherscan.io/address/0xd077A400968890Eacc75cdc901F0356c943e4fDb) |

The escrow contract source is in [`contracts/contracts/ConduitEscrow.sol`](./contracts/contracts/ConduitEscrow.sol)
(open / topUp / claim / settle / withdraw, EIP-712 vouchers, OpenZeppelin `SafeERC20` + `ReentrancyGuard` +
`EIP712` + `ECDSA`). Deployment record: [`contracts/deployed.sepolia.json`](./contracts/deployed.sepolia.json).

---

## Getting testnet funds

The buyer wallet needs **both**:

1. **Sepolia ETH** (gas to open/settle the channel) — e.g. [sepoliafaucet.com](https://sepoliafaucet.com),
   the [Alchemy](https://www.alchemy.com/faucets/ethereum-sepolia) or [Infura](https://www.infura.io/faucet/sepolia)
   faucets.
2. **Test USD₮** (the token above) — from the Pimlico / Candide faucet for the configured token.

> A fresh wallet with USD₮ but **no Sepolia ETH** cannot open a channel — escalation will fall back to a
> free local answer. Fund gas first.

---

## Running it

### Desktop app (easiest)
Download the installer for your OS from [Releases](https://github.com/Conduit-Organization/conduit/releases)
(Linux `.AppImage` / `.deb` available; macOS & Windows coming). It bundles the engine, wallet, and UI;
escrow is on by default. Or build from source:

```bash
npm run dist        # builds the Electron app → release/
```

### Headline demo (single machine)
```bash
npm run demo
```
One run: ① a cheap local 0.6B answers an easy prompt **free**; ② the agent detects low confidence,
**pays 0.01 USD₮**, and gets a SoTA answer from Qwen3-4B over E2E P2P; ③ a **freeloader is refused at
the handshake (0 bytes)** — with a live USD₮ ledger, a `cloud_bytes=0` counter, and a JSONL audit.

### Two devices (the real consult demo)
```bash
# Either device — a LAN-local DHT bootstrap so discovery needs no internet:
npm run bootstrap   # prints MEDCONSULT_BOOTSTRAP=<ip>:49737

# Device A (health worker): loads MedPsy-4B, serves the approval screen on :8799
MEDCONSULT_BOOTSTRAP=<ip>:49737 npm run sell

# Device B (asker): carries no model — every consult goes to the paid peer
MEDCONSULT_BOOTSTRAP=<ip>:49737 CONSULT="…" npm run ask
```
Both join the Hyperswarm topic `medconsult:demo:v1`; discovery and NAT hole-punching are automatic.
Omit `MEDCONSULT_BOOTSTRAP` to use the public Holepunch DHT as upstream does (needs internet to
bootstrap). The draft waits on the approval screen — **nothing reaches the asker until a human taps
Approve & Send.** Full sequence: [shoot-day checklist](#reproducing-the-demo-shoot-day-checklist).

### Chat + wallet web app
```bash
npm run app:install         # web-app deps (once)
npm run start               # app:build + serve → http://localhost:8788
# dev with hot-reload UI:   npm run app:dev   (Vite :5173, proxies /api → :8788)
```

### Audit run (model lifecycle + inference performance)
```bash
npm run audit               # loads models, runs inference, unloads — writes AUDIT_LOG.jsonl
```

---

## All commands

| command | what it does |
|---|---|
| **`npm run start`** | build + serve the chat + wallet web app → http://localhost:8788 |
| `npm run web` | serve the app + engine API (after `app:build`) |
| `npm run app:dev` | UI with hot-reload (Vite :5173 → engine :8788) |
| `npm run dist` | build the Electron desktop app → `release/` |
| `npm run demo` | headline: local-free → pay-to-escalate (4B) → freeloader-refused, with ledger + audit |
| `npm run audit` | model load/unload + inference performance → `AUDIT_LOG.jsonl` (no testnet needed) |
| `npm run market` | serverless storefront — independent peers meet over Hyperswarm and negotiate |
| **`npm run sell`** | **health worker**: loads MedPsy-4B, serves the approval screen (:8799), waits for consults |
| **`npm run ask`** | **asker** (aliases: `consult`, `buy`): no local model — delegates the consult to a paid peer |
| **`npm run bootstrap`** | LAN-local DHT bootstrap node so peer discovery needs no internet |
| `npm run agent` | autonomous buyer: confidence router + spend policy (free / pay / budget-decline) |
| `npm run route` | confidence router on easy vs. hard prompts (self-consistency, no logprobs) |
| `npm run bench` | capability prober — benchmarks the local GPU, writes `bench-profile.json` |
| `npm run escrow-demo` | open a channel, draw vouchers, settle — end to end on Sepolia |
| `npm run slice` | Phase-1 thin vertical slice (hand-scripted pay→gate→delegate→reject) |
| `npm run spike:firewall` / `spike:settle` / `spike:delegate` | the de-risking spikes |
| `npm run typecheck` | TypeScript check (engine) |

---

## Models

This fork serves exactly **one** model. Open-weight, runs fully on-device via QVAC, downloads on demand
into `~/.qvac`:

| Model | Role | Size | Measured (Apple M-series GPU) |
|-------|------|------|-------------------------------|
| **QVAC MedPsy-4B** (Q4_K_M, imatrix) | the health worker's serving model — the only tier | ~2.7 GB | ~4 s load from cache · 0.9–8 s TTFT · ~10–26 tok/s |

Referenced as the `@qvac/sdk` registry constant `HEALTHCARE_4B_MEDICAL_Q4_K_M`, which pins a commit sha
and sha256 so every device fetches byte-identical weights (needs `@qvac/sdk >= 0.16.0`). The asker's
device loads **no model at all**.

> Upstream's Qwen3 / Llama / EmbeddingGemma tiers and the MedPsy-1.7B tier are intentionally unused —
> there is no local-draft or confidence-router path in this fork. The seller node refuses to advertise
> a non-MedPsy model even if a stale `bench-profile.json` picks one.

(Throughput from `npm run bench` / `npm run audit` on the demo hardware above.)

---

## Audit log

Every demo run can emit a structured JSONL audit log — one event object per line. `npm run audit`
produces a self-contained, **testnet-free** run capturing the full model lifecycle and per-inference
performance; the committed [`AUDIT_LOG.sample.jsonl`](./AUDIT_LOG.sample.jsonl) is one such run.

**Event types**

| event | fields |
|-------|--------|
| `model_load` | `model`, `model_type`, `role`, `load_ms` |
| `inference` | `model`, `role`, `prompt`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `ttft_ms`, `tps`, `backend`, `cloud_bytes` |
| `model_unload` | `model`, `unload_ms` |
| `p2p` | `sub` (`gate_opened` / `handshake_granted` / `handshake_rejected`), peer keys, `bytes_served` |
| `settlement` | `network`, `amount_usdt`, `to`, `tx`, `status` |
| `consult` (fork) | `approved_by_human`, `outcome`, `review_ms`, `draft_ms`, `edited`, `cloud_bytes` |

Each role writes its own log: `AUDIT_LOG.health-worker.jsonl` and `AUDIT_LOG.asker.jsonl` (both
gitignored; the `*-sample.jsonl` files are committed artifacts).

Example inference line (real, from `npm run audit` on this fork):

```json
{"event":"inference","model":"HEALTHCARE_4B_MEDICAL_Q4_K_M","role":"health-worker","prompt":"Patient is 61 with known type 2 diabetes. A small blister on the sole of the right foot has been there 2 weeks, now with surrounding redness and a bad smell. No fever. They say it does not hurt much.","prompt_tokens":222,"completion_tokens":160,"total_tokens":382,"ttft_ms":894.44,"tps":17.91,"backend":"gpu","cloud_bytes":0}
```

`"backend":"gpu"` proves on-device execution; `"cloud_bytes":0` proves nothing went to a cloud.

**The fork's addition:** `approved_by_human` plus `review_ms` is the evidence the answer was **not**
autonomous — a human read the draft for that many milliseconds and chose to send it. A declined consult
logs `approved_by_human: false` with `outcome: "rejected_by_human"` and is never charged.

The on-chain settlement + handshake story (per-inference payment, freeloader rejection) is in
[`AUDIT_LOG.settlement-sample.jsonl`](./AUDIT_LOG.settlement-sample.jsonl), produced by `npm run demo`.

---

## Remote APIs — the no-cloud guarantee

- **AI inference / embeddings:** 100% via `@qvac/sdk`, on-device or on a paid peer over E2E Holepunch. **No cloud AI.**
- **Remote AI calls:** NONE.
- **Remote non-AI services:** a single blockchain **testnet RPC**, used only to submit/confirm USD₮
  settlement (per-inference payments + escrow channel open/top-up/claim/settle). No prompt, model, or
  token data is ever sent to it. RPC access is confined to `src/core/wallet.ts` and `src/core/escrow.ts`.
- **Prompt bytes sent to any cloud:** 0.

Full disclosure: [`REMOTE_APIS.md`](./REMOTE_APIS.md).

---

## Reproducing the demo (shoot-day checklist)

Two devices: **A = health worker** (needs the GPU — it runs MedPsy-4B), **B = asker** (carries no
model). Follow in order; the online steps are deliberately all before the airplane-mode moment.

### Phase 1 — while still online (off camera, or shown as setup)

- [ ] 1. Both devices on the **same Wi-Fi or hotspot**. Confirm each has a real private-LAN address
      (`192.168.x` / `10.x` / `172.16–31.x`). An iPhone **USB-tethering** link (`192.0.0.2/32`,
      `NOARP`) is **not** a LAN — Holepunch cannot connect over it and discovery will fail with a bare
      30-second timeout.
- [ ] 2. On each: `npm install` → `cp .env.example .env`. Sepolia: `CONDUIT_CHAIN_ID=11155111`,
      `CONDUIT_USDT_ADDRESS=0xd077A400968890Eacc75cdc901F0356c943e4fDb`, `CONDUIT_ESCROW=1`,
      `CONDUIT_ESCROW_ADDRESS=0x741BbE3B2d19E1aE965467280Cc2a442F3632Ee7`. For a faucet-free
      rehearsal use the local chain instead (`npx hardhat node` +
      `npx hardhat run scripts/deploy-local.ts --network localhost`) and copy the values it prints.
- [ ] 3. Fund the **asker** wallet (account 0): Sepolia ETH for gas + test USD₮. Skip on the local chain
      — the deploy script funds both roles.
- [ ] 4. On device A: `npm run bench` → writes `bench-profile.json`. Confirm it picks
      `HEALTHCARE_4B_MEDICAL_Q4_K_M` and reports `backend: "gpu"`.
- [ ] 5. **Pre-download the model on A**: first load pulls ~2.7 GB. Start `npm run sell` once and wait
      for `model ready`. From cache it then loads in ~4 s instead of minutes.
- [ ] 6. **Open the escrow channel now, on camera if you like — this is the one step that needs the
      internet.** Run one throwaway consult end to end (steps 9–12). The channel opens on-chain and is
      pre-funded; from here on, vouchers settle off-chain with no network.
- [ ] 7. Start the LAN-local DHT bootstrap on either device: `npm run bootstrap`. Note the
      `MEDCONSULT_BOOTSTRAP=<ip>:49737` line it prints. If it warns that it fell back to loopback,
      fix the network before continuing — loopback only works for both roles on one machine.

### Phase 2 — airplane mode (the shot)

- [ ] 8. **Enable airplane mode on both devices, then rejoin the local Wi-Fi/hotspot only.** Prove it on
      camera: `curl https://example.com` should fail.
- [ ] 9. Device A: `MEDCONSULT_BOOTSTRAP=<ip>:49737 npm run sell`. Confirm the startup lines read
      `discovery: LAN-local DHT via <ip> (no internet needed)` and
      `review consults at http://127.0.0.1:8799`. Open that screen — it is the approval surface.
- [ ] 10. Device B: `MEDCONSULT_BOOTSTRAP=<ip>:49737 CONSULT="…" npm run ask` (or the desktop app).
       Confirm the banner names the right chain and says this device carries no medical model.
- [ ] 11. On A's screen: the draft streams in token by token, then parks on **AWAITING HUMAN REVIEW**.
       Nothing has been sent. Edit a word or two so `edited: true` shows up in the log.
- [ ] 12. Tap **Approve & Send**. B receives the answer with the disclaimer beneath it; the voucher is
       signed in the same step. B's stamp reads *Reviewed & approved by a health worker*.
- [ ] 13. Show the **reject** path too: send a second consult and tap **Reject**. B reports
       *Health worker did not approve* — a human decision, not an error — and is **not** charged.

### Phase 3 — the proof

- [ ] 14. `AUDIT_LOG.health-worker.jsonl` — one line per consult with `approved_by_human: true`,
       `review_ms`, `draft_ms`, `backend: "gpu"`, `cloud_bytes: 0`, plus a `rejected_by_human` line
       for step 13.
- [ ] 15. `AUDIT_LOG.asker.jsonl` — the asker's view of the same consult, `cloud_bytes: 0`.
- [ ] 16. Back online, the health worker claims the accumulated balance on-chain → the settlement event.

**Expected numbers** (demo hardware, MedPsy-4B Q4_K_M on Apple-silicon GPU): model load ~4 s from
cache · draft ~0.9–8 s TTFT, ~10–26 tok/s · review time is however long the human takes (that is the
point) · `cloud_bytes = 0` throughout.

> **Fallback.** If the mobile port is not reliable in time, run the same checklist on two laptops.
> That is still a fully real demonstration of the same story — just not in-hand on phones. Say so
> rather than shipping something flaky.

### On phones

The Expo/Bare client lives in [`mobile/`](./mobile) — same two roles, same wire protocol, so a phone
and a laptop are interchangeable on either side of a consult. **It is scaffolded but has not yet been
run on a device** (QVAC does not run on simulators, and no physical device was available); see
[`mobile/README.md`](./mobile/README.md) for the architecture, the JSC/BigInt/local-network gotchas
already handled, and the known gaps. Until it has had a real device run, the two-laptop path above is
the dependable one for filming.

---

## Repository layout

```
app/         React chat + wallet UI (Vite)
mobile/      Expo/Bare client — Asker + Health Worker on physical phones      ← fork (unverified)
contracts/   Hardhat workspace — ConduitEscrow.sol, MockUSDT, tests, deploy script
electron/    desktop shell (spawns the engine as a child process)
landing/     marketing site + /pitch deck (Next.js) — conduitt.xyz
src/
  core/      identity · env · config · wallet · escrow · audit · ledger · prober · pricing · protocol · reputation · keystore
             medconsult (model + topic + prompt + disclaimer) · swarm (LAN-local DHT)   ← fork
  sell/      provider              (payment-gated QVAC provider)
             consult (MedPsy draft + approval state machine)                            ← fork
             approval-server · approval-page (the health worker's review screen)        ← fork
  buy/       router · agent · market-agent · policy · storefront · consumer
  node/      sell · buy            (health worker / asker nodes)
  web/       server · seller       (engine API: /api/state + /api/ask — and serves the built app)
  scripts/   demo · audit-demo · market-demo · agent-demo · route-test · bench · slice · escrow-demo
             bootstrap (LAN-local DHT bootstrap node)                                   ← fork
  spikes/    01-firewall · 02-settlement · 03-prober-delegate
docs/        architecture, build phases, diagrams, submission copy
```

---

## License

[Apache-2.0](./LICENSE). Testnet demonstration only — not a live money-transmission service.

A fork of [Conduit](https://github.com/Conduit-Organization/conduit) by the Conduit Organization, used
under Apache-2.0 with the licence and attribution intact. The P2P discovery, escrow voucher channel,
capability prober, reputation system and audit logger are their work; see
[what changed vs upstream](#what-changed-vs-upstream-conduit) for what this fork added.

**Not medical advice.** Answers are an AI-assisted draft reviewed by a human health worker before
sending — not a substitute for professional medical care in an emergency.
