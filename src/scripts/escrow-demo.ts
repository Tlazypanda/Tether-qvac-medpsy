// Escrow payment-channel lifecycle demo — exercises ConduitEscrow on live Sepolia with real test-USD₮.
// Proves the whole money-flow with our client: open → off-chain vouchers → seller claim → settle + refund.
// Buyer = wallet account 0, seller = account 1 (the same split the storefront uses). Run: npm run escrow-demo
import { HDNodeWallet, Contract, formatUnits, type Wallet } from 'ethers';
import { loadEnv } from '../core/env';
import { createEscrowClient, loadEscrowDeployment, makeProvider } from '../core/escrow';

const DEC = 6;
const usd = (n: bigint) => formatUnits(n, DEC) + ' USD₮';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const e = loadEnv();
const mnemonic = e.mnemonic || e.CONDUIT_WALLET_MNEMONIC || '';
const rpc = e.CONDUIT_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const token = e.CONDUIT_USDT_ADDRESS || '0xd077A400968890Eacc75cdc901F0356c943e4fDb';
const dep = loadEscrowDeployment();
if (!mnemonic) throw new Error('no mnemonic in .env');
if (!dep) throw new Error('no escrow deployment (contracts/deployed.sepolia.json)');

// makeProvider, not `new JsonRpcProvider`: this demo fires several settlement txs back to back and
// ethers' 250 ms request cache hands two of them the same nonce on a local chain. See core/escrow.ts.
const provider = makeProvider(rpc);
const acct = (i: number) => HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`).connect(provider) as unknown as Wallet;
const buyer = acct(0);
const seller = acct(1);
const esc = createEscrowClient(rpc, dep.address, dep.chainId);
const erc20: any = new Contract(token, ['function balanceOf(address) view returns (uint256)'], provider);
const bal = (a: string) => erc20.balanceOf(a) as Promise<bigint>;

const DEPOSIT = 50_000n; // 0.05 USD₮
const PRICE = 10_000n; // 0.01 USD₮ / inference
const DURATION = 600; // 10 min

console.log(`escrow ${dep.address} (chain ${dep.chainId})`);
console.log(`buyer  ${buyer.address}`);
console.log(`seller ${seller.address}\n`);

// Pre-flight: if a channel is already open from a prior run, close it cleanly so this run starts fresh.
let ch = await esc.channel(buyer.address, seller.address);
if (ch.open) {
  console.log('• leftover channel open — settling at claimed to reset…');
  const v = await esc.signVoucher(buyer, seller.address, ch.epoch, ch.claimed);
  await esc.settle(seller, buyer.address, ch.claimed, v);
  ch = await esc.channel(buyer.address, seller.address);
}

const buyer0 = await bal(buyer.address);
const seller0 = await bal(seller.address);
console.log(`start balances → buyer ${usd(buyer0)} · seller ${usd(seller0)}\n`);

// 1) OPEN — one on-chain tx (approve + open). This is the *only* on-chain wait of the session.
console.log(`1) buyer opens a channel, depositing ${usd(DEPOSIT)} …`);
const openTx = await esc.open(buyer, token, seller.address, DEPOSIT, DURATION);
ch = await esc.channel(buyer.address, seller.address);
console.log(`   opened (tx ${openTx.slice(0, 14)}…) · epoch ${ch.epoch} · deposit ${usd(ch.deposit)}\n`);

// 2) DRAW — per inference the buyer signs a cumulative voucher off-chain (INSTANT, no tx).
console.log('2) buyer signs 3 vouchers off-chain (one per inference — instant, no gas) …');
let cumulative = 0n;
for (let i = 1; i <= 3; i++) {
  cumulative += PRICE;
  const sig = await esc.signVoucher(buyer, seller.address, ch.epoch, cumulative);
  const signer = esc.recoverVoucher(buyer.address, seller.address, ch.epoch, cumulative, sig);
  const ok = signer.toLowerCase() === buyer.address.toLowerCase() && cumulative <= ch.deposit;
  console.log(`   voucher ${i}: cumulative ${usd(cumulative)} · seller verifies ${ok ? 'OK ✓' : 'FAIL ✗'}`);
  if (!ok) throw new Error('voucher verification failed off-chain');
}
const lastSig = await esc.signVoucher(buyer, seller.address, ch.epoch, cumulative);

// 3) CLAIM — seller redeems mid-session (channel stays open). One on-chain tx by the SELLER.
console.log(`\n3) seller claims the running total ${usd(cumulative)} on-chain …`);
const claimTx = await esc.claim(seller, buyer.address, cumulative, lastSig);
ch = await esc.channel(buyer.address, seller.address);
console.log(`   claimed (tx ${claimTx.slice(0, 14)}…) · channel.claimed ${usd(ch.claimed)} · still open ${ch.open}`);
console.log(`   seller balance ${usd(await bal(seller.address))} (was ${usd(seller0)})\n`);

// 4) SETTLE — close the session: seller takes its total, buyer refunded the remainder.
console.log('4) seller settles + closes the channel (final voucher) …');
const settleTx = await esc.settle(seller, buyer.address, cumulative, lastSig);
ch = await esc.channel(buyer.address, seller.address);
const buyer1 = await bal(buyer.address);
const seller1 = await bal(seller.address);
console.log(`   settled (tx ${settleTx.slice(0, 14)}…) · channel.open ${ch.open}\n`);

console.log('── result ──────────────────────────────');
console.log(`buyer  ${usd(buyer0)} → ${usd(buyer1)}   (Δ ${usd(buyer1 - buyer0)})`);
console.log(`seller ${usd(seller0)} → ${usd(seller1)}   (Δ ${usd(seller1 - seller0)})`);
const buyerSpent = buyer0 - buyer1;
const sellerEarned = seller1 - seller0;
const pass = buyerSpent === cumulative && sellerEarned === cumulative && !ch.open;
console.log(`spent = earned = ${usd(cumulative)} · channel closed · ${pass ? 'PASS ✅' : 'MISMATCH ✗'}`);
await sleep(200);
process.exit(pass ? 0 : 1);
