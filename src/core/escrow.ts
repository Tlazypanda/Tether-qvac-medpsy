// Conduit escrow client — talks to the deployed ConduitEscrow payment-channel contract (M4e).
//
// Buyer: open a channel (approve + open), then sign EIP-712 vouchers off-chain (instant, per inference).
// Seller: read the channel on-chain to verify the grant, redeem vouchers via claim/settle.
// The EIP-712 domain/types here MUST match contracts/ConduitEscrow.sol exactly, or claims revert.
import { Contract, JsonRpcProvider, TypedDataEncoder, verifyTypedData, type BaseWallet, type Signer } from 'ethers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ESCROW_ABI = [
  'function open(address seller, uint256 amount, uint64 duration)',
  'function topUp(address seller, uint256 amount)',
  'function claim(address buyer, uint256 cumulativeAmount, bytes signature)',
  'function settle(address buyer, uint256 cumulativeAmount, bytes signature)',
  'function withdraw(address seller)',
  'function channels(address buyer, address seller) view returns (uint256 deposit, uint256 claimed, uint64 expiry, uint64 epoch, bool open)',
  'function token() view returns (address)',
  'function voucherDigest(address buyer, address seller, uint64 epoch, uint256 cumulativeAmount) view returns (bytes32)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'epoch', type: 'uint64' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
} as const;

export interface ChannelState {
  deposit: bigint;
  claimed: bigint;
  expiry: bigint;
  epoch: bigint;
  open: boolean;
}

export interface EscrowClient {
  address: string;
  chainId: number;
  domain(): { name: string; version: string; chainId: number; verifyingContract: string };
  channel(buyer: string, seller: string): Promise<ChannelState>;
  tokenAddress(): Promise<string>;
  voucherDigestOnchain(buyer: string, seller: string, epoch: bigint, cumulative: bigint): Promise<string>;
  signVoucher(signer: Signer, seller: string, epoch: bigint, cumulative: bigint): Promise<string>;
  recoverVoucher(buyer: string, seller: string, epoch: bigint, cumulative: bigint, signature: string): string;
  // signing txs (need a connected Wallet):
  open(wallet: BaseWallet, token: string, seller: string, amount: bigint, durationSecs: number): Promise<string>;
  topUp(wallet: BaseWallet, token: string, seller: string, amount: bigint): Promise<string>;
  claim(wallet: BaseWallet, buyer: string, cumulative: bigint, signature: string): Promise<string>;
  settle(wallet: BaseWallet, buyer: string, cumulative: bigint, signature: string): Promise<string>;
  withdraw(wallet: BaseWallet, seller: string): Promise<string>;
}

/**
 * A JSON-RPC provider with ethers' response cache disabled.
 *
 * WHY: ethers v6 de-duplicates identical RPC requests made within 250 ms — including
 * `eth_getTransactionCount`, which is how a nonce is chosen. Settlement sends two transactions
 * back to back (`approve()` then `open()`), and on a local Hardhat chain both land inside that
 * window, so the second reads the pre-`approve` nonce and the node rejects it:
 *
 *     Nonce too low. Expected nonce to be 6 but got 5.
 *
 * Invisible on Sepolia, where block times dwarf the cache, and fatal on the local chain — i.e. it
 * only breaks the setup recommended for development. Every provider used for settlement must be
 * built here rather than with `new JsonRpcProvider(...)` directly.
 */
export function makeProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
}

export function createEscrowClient(rpcUrl: string, address: string, chainId: number): EscrowClient {
  const provider = makeProvider(rpcUrl);
  const read: any = new Contract(address, ESCROW_ABI, provider);
  const domain = { name: 'ConduitEscrow', version: '1', chainId, verifyingContract: address };
  const value = (buyer: string, seller: string, epoch: bigint, cumulative: bigint) => ({ buyer, seller, epoch, cumulativeAmount: cumulative });

  async function ensureAllowance(wallet: BaseWallet, token: string, amount: bigint) {
    const erc20: any = new Contract(token, ERC20_ABI, wallet);
    const allow: bigint = await erc20.allowance(wallet.address, address);
    if (allow < amount) { const tx = await erc20.approve(address, amount); await tx.wait(); }
  }
  const writeContract = (wallet: BaseWallet): any => new Contract(address, ESCROW_ABI, wallet);

  return {
    address,
    chainId,
    domain: () => domain,
    async channel(buyer, seller) {
      const c = await read.channels(buyer, seller);
      return { deposit: c[0], claimed: c[1], expiry: c[2], epoch: c[3], open: c[4] };
    },
    tokenAddress: () => read.token(),
    voucherDigestOnchain: (buyer, seller, epoch, cumulative) => read.voucherDigest(buyer, seller, epoch, cumulative),
    async signVoucher(signer, seller, epoch, cumulative) {
      const buyer = await signer.getAddress();
      return signer.signTypedData(domain, VOUCHER_TYPES as any, value(buyer, seller, epoch, cumulative));
    },
    recoverVoucher(buyer, seller, epoch, cumulative, signature) {
      return verifyTypedData(domain, VOUCHER_TYPES as any, value(buyer, seller, epoch, cumulative), signature);
    },
    async open(wallet, token, seller, amount, durationSecs) {
      await ensureAllowance(wallet, token, amount);
      const tx = await writeContract(wallet).open(seller, amount, durationSecs);
      await tx.wait();
      return tx.hash;
    },
    async topUp(wallet, token, seller, amount) {
      await ensureAllowance(wallet, token, amount);
      const tx = await writeContract(wallet).topUp(seller, amount);
      await tx.wait();
      return tx.hash;
    },
    async claim(wallet, buyer, cumulative, signature) {
      const tx = await writeContract(wallet).claim(buyer, cumulative, signature); await tx.wait(); return tx.hash;
    },
    async settle(wallet, buyer, cumulative, signature) {
      const tx = await writeContract(wallet).settle(buyer, cumulative, signature); await tx.wait(); return tx.hash;
    },
    async withdraw(wallet, seller) {
      const tx = await writeContract(wallet).withdraw(seller); await tx.wait(); return tx.hash;
    },
  };
}

// Off-chain EIP-712 digest (to compare against the on-chain voucherDigest as a wiring sanity check).
export function offchainVoucherDigest(domain: any, buyer: string, seller: string, epoch: bigint, cumulative: bigint): string {
  return TypedDataEncoder.hash(domain, VOUCHER_TYPES as any, { buyer, seller, epoch, cumulativeAmount: cumulative });
}

// Resolve the deployed escrow address: env override, else contracts/deployed.sepolia.json.
export function loadEscrowDeployment(): { address: string; chainId: number } | null {
  if (process.env.CONDUIT_ESCROW_ADDRESS) {
    return { address: process.env.CONDUIT_ESCROW_ADDRESS, chainId: Number(process.env.CONDUIT_CHAIN_ID || '11155111') };
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const j = JSON.parse(readFileSync(path.join(here, '../../contracts/deployed.sepolia.json'), 'utf8'));
    return { address: j.escrow, chainId: Number(j.chainId) };
  } catch {
    return null;
  }
}
