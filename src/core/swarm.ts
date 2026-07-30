// How this fork's nodes join the DHT.
//
// WHY THIS EXISTS. Upstream Conduit joins Hyperswarm with default options, which bootstrap off the
// PUBLIC Holepunch DHT — a set of internet-reachable nodes. That is fine for upstream's demo (two
// laptops on "independent networks", i.e. both online), but this demo claims two devices in
// airplane mode. Peer *discovery* still has to happen somehow, and on a network with no route to
// the public bootstrap nodes it simply will not.
//
// So a node can be pointed at a LAN-local bootstrap instead:
//
//   MEDCONSULT_BOOTSTRAP=192.168.1.50:49737 npm run sell
//   MEDCONSULT_BOOTSTRAP=192.168.1.50:49737 npm run ask
//
// with `npm run bootstrap` running on one device (or a laptop sharing the hotspot). Discovery,
// hole-punching and the E2E-encrypted link then happen entirely over the local network, with no
// internet at any point. Leave the variable unset to use the public DHT exactly as upstream does.
//
// This is a discovery/transport concern only: it changes nothing about payment, the model, or the
// approval gate. It is called out here because "no internet" is a claim the demo makes on camera.

export interface SwarmOptions {
  bootstrap?: Array<{ host: string; port: number }>;
}

/** Parse `host:port,host:port` into hyperdht bootstrap entries. */
export function parseBootstrap(spec: string | undefined): Array<{ host: string; port: number }> | undefined {
  if (!spec || !spec.trim()) return undefined;
  const nodes = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf(':');
      if (i <= 0) throw new Error(`bad MEDCONSULT_BOOTSTRAP entry "${entry}" — expected host:port`);
      const host = entry.slice(0, i);
      const port = Number(entry.slice(i + 1));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`bad MEDCONSULT_BOOTSTRAP port in "${entry}"`);
      }
      return { host, port };
    });
  return nodes.length ? nodes : undefined;
}

/**
 * Options for `new Hyperswarm(...)`. Returns `{}` when no local bootstrap is configured, so the
 * default public-DHT behaviour is byte-for-byte upstream's.
 */
export function swarmOptions(): SwarmOptions {
  const bootstrap = parseBootstrap(process.env.MEDCONSULT_BOOTSTRAP);
  return bootstrap ? { bootstrap } : {};
}

/** One-line description of how this node will find peers — printed at startup so it's never a guess. */
export function discoveryMode(): string {
  const bootstrap = parseBootstrap(process.env.MEDCONSULT_BOOTSTRAP);
  return bootstrap
    ? `LAN-local DHT via ${bootstrap.map((b) => `${b.host}:${b.port}`).join(', ')} (no internet needed)`
    : 'public Holepunch DHT (needs internet to bootstrap)';
}
