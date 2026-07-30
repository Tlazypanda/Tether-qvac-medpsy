// `npm run bootstrap` — a LAN-local DHT, so peer discovery needs no internet.
//
// Not in upstream Conduit: upstream's nodes always bootstrap off the public Holepunch DHT. For a demo
// filmed in airplane mode, discovery has to work on a local network with no route out. Run this once
// on any device on the shared Wi-Fi/hotspot, then point both roles at it:
//
//   npm run bootstrap                                       (this device, prints its address)
//   MEDCONSULT_BOOTSTRAP=<addr> npm run sell                (health worker)
//   MEDCONSULT_BOOTSTRAP=<addr> npm run ask                 (asker)
//
// This node carries no consult data and holds no keys — it only helps peers find each other. The
// consult link itself is still direct and end-to-end encrypted between the two devices.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS STARTS SEVERAL NODES AND NOT ONE
//
// The obvious implementation — a single `DHT.bootstrapper()` — does not work, and fails in a way that
// wastes an afternoon: the ASKER reports `no health worker found in 30s` while the health worker sits
// there apparently healthy, and a packet-level look shows the client opening a connection that the
// server never sees. It looks exactly like a NAT/firewall problem and it is not one.
//
// The cause is that hyperdht does not connect peers directly; it coordinates the connection through
// OTHER nodes in the DHT, which must be non-ephemeral and non-firewalled to serve that role. With one
// node there is nothing to relay through, so the handshake half-completes and dies.
//
// Measured on loopback with this exact code (`npm run ask` equivalent, 20s budget):
//
//     nodes │ server fired │ offer delivered
//     ──────┼──────────────┼────────────────
//       1   │      no      │      no          ← the single-bootstrapper bug
//       2   │      no      │      no
//       3   │      no      │      no
//       5   │     yes      │     yes
//      10   │     yes      │     yes
//
// So we run `hyperdht`'s own `createTestnet` helper, which builds exactly this: N nodes with
// `ephemeral: false, firewalled: false`. Default 10, matching the helper's own default, for margin
// over the observed threshold of 5. It is nominally a test helper, but it is the library's tested way
// to stand up a self-contained DHT and that is precisely what an offline demo needs.
import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createTestnet = require('hyperdht/testnet');

const port = Number(process.env.BOOTSTRAP_PORT || 49737);
// Below 5 the handshake half-completes (see the table above). Refuse to start a network that cannot
// work rather than hand someone a 30-second timeout to debug.
const MIN_NODES = 5;
const requested = Number(process.env.BOOTSTRAP_NODES || 10);

/**
 * True for an address on a real private LAN — the RFC1918 ranges a phone/laptop gets from Wi-Fi or
 * a hotspot (192.168.x.x, 10.x.x.x, 172.16–31.x.x).
 *
 * Everything else that shows up as "not internal" is a trap for this demo, so it is ranked below:
 * macOS lists 192.0.0.x (iPhone USB tethering, a NOARP /32), 169.254.x.x (link-local, no DHCP), and
 * assorted VPN/utun addresses. A bootstrap bound to a /32 tethering address accepts the bind and
 * looks healthy, then no other device can route to it.
 */
function isPrivateLan(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n))) return false;
  if (o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true;
  return false;
}

/** Candidate IPv4 addresses of this device, best first. */
function lanAddresses(): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // A /32 has no subnet, so no other device can route to it.
      const slash32 = a.netmask === '255.255.255.255';
      if (isPrivateLan(a.address) && !slash32) preferred.push(a.address);
      else fallback.push(a.address);
    }
  }
  return [...preferred, ...fallback];
}

const lan = lanAddresses();
const routable = lan.filter(isPrivateLan);
// A DHT node must advertise the concrete address peers will dial. Default to this device's LAN IP
// (what a two-device demo needs); fall back to loopback, which only works for both roles on one host.
const host = process.env.BOOTSTRAP_HOST || routable[0] || '127.0.0.1';

const nodes = Math.max(MIN_NODES, requested);
if (requested < MIN_NODES) {
  console.log(`(BOOTSTRAP_NODES=${requested} raised to ${MIN_NODES} — fewer cannot relay a handshake)`);
}

// createTestnet binds every node to 0.0.0.0 unless host is loopback, so the other device can reach
// them; the returned `bootstrap` list is the entry point peers dial.
const testnet = await createTestnet(nodes, { host, port });
const entry = testnet.bootstrap?.[0] ?? { host, port };

console.log('=== med-consult — LAN-local DHT ===');
console.log(`${testnet.nodes.length} nodes, entry point ${entry.host}:${entry.port}`);
if (host === '127.0.0.1') {
  console.log('\nNOTE: bound to loopback — reachable only from THIS machine, which is fine for running');
  console.log('      both roles here, but NOT for a two-device demo.');
  if (lan.length) {
    console.log(`      Skipped non-routable interface(s): ${lan.join(', ')} — no private LAN address`);
    console.log('      (tethering /32, link-local or VPN). Join a shared Wi-Fi/hotspot for two devices.');
  } else {
    console.log('      No external network interface found — join a shared Wi-Fi/hotspot first.');
  }
}
console.log('\nPoint both roles at this node (same Wi-Fi / hotspot, no internet required):');
console.log(`  MEDCONSULT_BOOTSTRAP=${entry.host}:${entry.port}`);
for (const ip of routable) {
  if (ip !== entry.host) console.log(`  MEDCONSULT_BOOTSTRAP=${ip}:${entry.port}   (alternate interface)`);
}
console.log('\nThis DHT relays discovery only. Consults stay end-to-end encrypted between peers.');
console.log('Ctrl-C to stop.');

async function shutdown() {
  try { await testnet.destroy(); } catch { /* already down */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
