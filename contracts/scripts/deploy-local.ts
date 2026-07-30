// Deploy MockUSDT + ConduitEscrow to a LOCAL Hardhat node, and fund the demo wallet.
//
// Why this exists (not in upstream Conduit): upstream only ships a Sepolia deploy script, so
// exercising the full pay → approve → settle loop needed real testnet funds and a faucet round
// trip. This gives the same loop against a throwaway local chain, which makes the human-approval
// gate testable in CI and on a plane, and keeps "testnet only" honest — no faucet, no real keys.
//
// Run:  npx hardhat node                                  (terminal 1)
//       npx hardhat run scripts/deploy-local.ts --network localhost   (terminal 2)
import { ethers, network } from 'hardhat';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Hardhat's well-known dev mnemonic. Public, unfunded on every real network, and safe to commit.
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';

async function main() {
  if (network.name !== 'localhost' && network.name !== 'hardhat') {
    throw new Error(`refusing to run the local deploy against "${network.name}" — use --network localhost`);
  }

  const [deployer] = await ethers.getSigners();
  console.log('network :', network.name);
  console.log('deployer:', deployer.address);

  const usdt = await (await ethers.getContractFactory('MockUSDT')).deploy();
  await usdt.waitForDeployment();
  const token = await usdt.getAddress();

  const escrow = await (await ethers.getContractFactory('ConduitEscrow')).deploy(token);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();

  const onchainToken = await escrow.token();
  if (onchainToken.toLowerCase() !== token.toLowerCase()) throw new Error('deployed token mismatch');

  // Fund the asker (account 0 of the dev mnemonic) with test USD₮ so it can open a channel.
  // Account 1 of the same mnemonic is the health worker's earnings address.
  const asker = ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, "m/44'/60'/0'/0/0");
  const worker = ethers.HDNodeWallet.fromPhrase(DEV_MNEMONIC, undefined, "m/44'/60'/0'/0/1");
  await (await usdt.mint(asker.address, 1_000_000_000n)).wait(); // 1,000 USD₮ (6 dec)

  // …and enough gas for both roles to transact on this throwaway chain.
  for (const a of [asker.address, worker.address]) {
    await (await deployer.sendTransaction({ to: a, value: ethers.parseEther('100') })).wait();
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = { chainId, network: network.name, escrow: address, token, deployedBy: deployer.address };
  writeFileSync(path.join(__dirname, '..', 'deployed.local.json'), JSON.stringify(out, null, 2) + '\n');

  console.log('\n✓ MockUSDT      →', token);
  console.log('✓ ConduitEscrow →', address);
  console.log('✓ asker        ', asker.address, '| 1000 test USD₮ + 100 ETH');
  console.log('✓ health worker', worker.address, '| 100 ETH');
  console.log('  wrote contracts/deployed.local.json');
  console.log('\nPut this in .env (LOCAL CHAIN ONLY):');
  console.log(`  CONDUIT_WALLET_MNEMONIC="${DEV_MNEMONIC}"`);
  console.log('  CONDUIT_RPC_URL=http://127.0.0.1:8545');
  console.log(`  CONDUIT_CHAIN_ID=${chainId}`);
  console.log(`  CONDUIT_USDT_ADDRESS=${token}`);
  console.log('  CONDUIT_ESCROW=1');
  console.log(`  CONDUIT_ESCROW_ADDRESS=${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
