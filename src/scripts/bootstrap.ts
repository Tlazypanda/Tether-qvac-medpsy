// `npm run bootstrap` — a LAN-local DHT bootstrap node, so peer discovery needs no internet.
//
// Not in upstream Conduit: upstream's nodes always bootstrap off the public Holepunch DHT. For a
// demo filmed in airplane mode, discovery has to work on a local network with no route out. Run
// this once on any device on the shared Wi-Fi/hotspot, then point both roles at it:
//
//   npm run bootstrap                                       (this device, prints its address)
//   MEDCONSULT_BOOTSTRAP=<addr> npm run sell                (health worker)
//   MEDCONSULT_BOOTSTRAP=<addr> npm run ask                 (asker)
//
// This node carries no consult data and holds no keys — it only helps peers find each other. The
// consult link itself is still direct and end-to-end encrypted between the two devices.
import { networkInterfaces } from 'node:os';
import DHT from 'hyperdht';

const port = Number(process.env.BOOTSTRAP_PORT || 49737);

/**
 * True for an address on a real private LAN — the RFC1918 ranges a phone/laptop gets from Wi-Fi or
 * a hotspot (192.168.x.x, 10.x.x.x, 172.16–31.x.x).
 *
 * Everything else that shows up as "not internal" is a trap for this demo, so it is ranked below:
 * macOS lists 192.0.0.x (iPhone USB tethering, a NOARP /32), 169.254.x.x (link-local, no DHCP), and
 * assorted VPN/utun addresses. Learned the hard way — a bootstrap bound to a /32 tethering address
 * accepts the bind and looks healthy, then peers simply never find each other and `npm run ask`
 * fails with a bare 30-second timeout.
 */
function isPrivateLan(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n))) return false;
  if (o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true;
  return false;
}

/**
 * Candidate IPv4 addresses of this device, best first: real private-LAN addresses ahead of the
 * oddities above, so `lan[0]` is the one an operator actually wants to hand to the other device.
 */
function lanAddresses(): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // A /32 has no subnet, so no other device can route to it — never a usable bootstrap address.
      const slash32 = a.netmask === '255.255.255.255';
      if (isPrivateLan(a.address) && !slash32) preferred.push(a.address);
      else fallback.push(a.address);
    }
  }
  return [...preferred, ...fallback];
}

const lan = lanAddresses();
const routable = lan.filter(isPrivateLan);
// dht-rpc rejects a wildcard here: a bootstrap node must advertise the concrete address peers will
// dial. Default to this device's LAN IP (what the demo needs); fall back to loopback, which is only
// useful for running both roles on one machine.
const host = process.env.BOOTSTRAP_HOST || routable[0] || '127.0.0.1';

const node = DHT.bootstrapper(port, host);
await node.ready();

console.log('=== med-consult — LAN-local DHT bootstrap ===');
console.log(`listening on ${host}:${port}`);
if (host === '127.0.0.1') {
  console.log('\nNOTE: bound to loopback — reachable only from THIS machine, which is fine for running');
  console.log('      both roles here, but NOT for a two-device demo.');
  if (lan.length) {
    // The dangerous case: addresses exist, but none is on a routable private LAN. Say so explicitly
    // rather than silently binding to one and failing at discovery time.
    console.log(`      Skipped non-routable interface(s): ${lan.join(', ')} — no private LAN address`);
    console.log('      (tethering /32, link-local or VPN). Join a shared Wi-Fi/hotspot for two devices.');
  } else {
    console.log('      No external network interface found — join a shared Wi-Fi/hotspot first.');
  }
}
console.log('\nPoint both roles at this node (same Wi-Fi / hotspot, no internet required):');
console.log(`  MEDCONSULT_BOOTSTRAP=${host}:${port}`);
for (const ip of routable) {
  if (ip !== host) console.log(`  MEDCONSULT_BOOTSTRAP=${ip}:${port}   (alternate interface)`);
}
console.log('\nThis node relays discovery only. Consults stay end-to-end encrypted between peers.');
console.log('Ctrl-C to stop.');

async function shutdown() {
  try { await node.destroy(); } catch { /* already down */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
