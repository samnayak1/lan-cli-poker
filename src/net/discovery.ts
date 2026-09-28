import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { APP_ID, DISCOVERY_PORT, type Beacon } from './protocol.js';

export interface DiscoveredHost extends Beacon {
  address: string;
  lastSeen: number;
}

/** Non-internal IPv4 addresses of this machine, e.g. ["192.168.1.23"]. */
export function lanAddresses(): string[] {
  return lanInterfaces().map((i) => i.address);
}

function lanInterfaces(): { address: string; broadcast: string }[] {
  const out: { address: string; broadcast: string }[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      const broadcast = ip.map((b, k) => (b | (~mask[k]! & 255)) >>> 0).join('.');
      out.push({ address: i.address, broadcast });
    }
  }
  return out;
}

/** Broadcasts this table on the LAN every 1.5s. Returns a stop function. */
export function startBeacon(info: () => Omit<Beacon, 'app'>): () => void {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  let ready = false;
  socket.on('error', () => {
    /* broadcasting is best-effort; joiners can always type the address */
  });
  socket.bind(() => {
    socket.setBroadcast(true);
    ready = true;
    send();
  });

  const send = () => {
    if (!ready) return;
    const payload = Buffer.from(JSON.stringify({ app: APP_ID, ...info() }));
    const targets = new Set(['255.255.255.255', ...lanInterfaces().map((i) => i.broadcast)]);
    for (const t of targets) socket.send(payload, DISCOVERY_PORT, t, () => { });
  };
  const interval = setInterval(send, 1500);

  return () => {
    clearInterval(interval);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };
}

/** Listens for beacons and reports the live host list whenever it changes. Returns a stop function. */
export function discoverHosts(onChange: (hosts: DiscoveredHost[]) => void): () => void {
  const hosts = new Map<string, DiscoveredHost>();
  let socket: Socket | null = createSocket({ type: 'udp4', reuseAddr: true });
  const publish = () => onChange([...hosts.values()].sort((a, b) => a.tableName.localeCompare(b.tableName)));

  socket.on('message', (buf, rinfo) => {
    try {
      const beacon = JSON.parse(buf.toString()) as Beacon;
      if (beacon.app !== APP_ID) return;
      hosts.set(`${rinfo.address}:${beacon.port}`, { ...beacon, address: rinfo.address, lastSeen: Date.now() });
      publish();
    } catch {
      /* not ours */
    }
  });
  socket.on('error', () => {
    socket?.close();
    socket = null;
  });
  socket.bind(DISCOVERY_PORT);

  const sweep = setInterval(() => {
    let removed = false;
    for (const [key, h] of hosts) {
      if (Date.now() - h.lastSeen > 5000) removed = hosts.delete(key) || removed;
    }
    if (removed) publish();
  }, 1000);

  return () => {
    clearInterval(sweep);
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
  };
}
