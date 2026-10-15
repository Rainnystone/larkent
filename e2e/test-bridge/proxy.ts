import { createServer, type Server, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

export const PROXY_MODES = ['off', 'disconnect', 'blackhole', 'eproto', 'eai_again', 'slow'] as const;
export type FaultProxyMode = (typeof PROXY_MODES)[number];

export interface FaultProxyExtra {
  delayMs?: number;
  hosts?: string[];
}

export interface StartFaultProxyOptions extends FaultProxyExtra {
  mode: FaultProxyMode;
}

export interface FaultProxyHandle {
  url: string;
  mode: FaultProxyMode;
  setMode(mode: FaultProxyMode, extra?: FaultProxyExtra): void;
  close(): Promise<void>;
}

const EAI_AGAIN_URL = 'http://eai-again.larkent-e2e.invalid:9';
/** Fatal TLS alert: unexpected_message. Clients surface this as EPROTO. */
const EPROTO_ALERT = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x0a]);

export async function startFaultProxy(opts: StartFaultProxyOptions): Promise<FaultProxyHandle> {
  let mode = opts.mode;
  let delayMs = opts.delayMs ?? 250;
  let hosts = opts.hosts ?? [];
  const sockets = new Set<Socket>();

  if (mode === 'eai_again') {
    return {
      url: EAI_AGAIN_URL,
      get mode() {
        return mode;
      },
      setMode(next, extra) {
        mode = next;
        if (extra?.delayMs !== undefined) delayMs = extra.delayMs;
        if (extra?.hosts !== undefined) hosts = extra.hosts;
      },
      async close() {
        /* advertised host never binds */
      },
    };
  }

  const server: Server = createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('CONNECT only');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('connect', (req: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    void handleConnect(req, socket, () => mode, () => delayMs, () => hosts);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fault proxy did not bind');
  }
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    get mode() {
      return mode;
    },
    setMode(next, extra) {
      mode = next;
      if (extra?.delayMs !== undefined) delayMs = extra.delayMs;
      if (extra?.hosts !== undefined) hosts = extra.hosts;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleConnect(
  req: IncomingMessage,
  socket: Socket,
  currentMode: () => FaultProxyMode,
  currentDelay: () => number,
  currentHosts: () => string[],
): Promise<void> {
  const destHost = (req.url ?? '').split(':')[0] ?? '';
  if (!hostSelected(destHost, currentHosts())) {
    tunnel(req, socket);
    return;
  }
  const mode = currentMode();
  switch (mode) {
    case 'blackhole':
      return;
    case 'disconnect':
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      resetSocket(socket);
      return;
    case 'eproto': {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let poisoned = false;
      const poison = (): void => {
        if (poisoned) return;
        poisoned = true;
        // Plain HTTP on a TLS client is the usual EPROTO / ERR_SSL_* path.
        socket.write(EPROTO_ALERT);
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      };
      socket.once('data', poison);
      queueMicrotask(() => {
        if (socket.readableLength > 0) poison();
      });
      return;
    }
    case 'eai_again':
      socket.destroy();
      return;
    case 'slow':
      await sleep(currentDelay());
      tunnel(req, socket);
      return;
    case 'off':
      tunnel(req, socket);
      return;
    default: {
      const _never: never = mode;
      throw new Error(`unhandled proxy mode: ${String(_never)}`);
    }
  }
}

function tunnel(req: IncomingMessage, socket: Socket): void {
  const [host, portText] = (req.url ?? '').split(':');
  const port = Number(portText);
  if (!host || !Number.isFinite(port)) {
    socket.destroy();
    return;
  }
  const dest = netConnect(port, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    dest.pipe(socket);
    socket.pipe(dest);
  });
  dest.on('error', () => socket.destroy());
  socket.on('error', () => dest.destroy());
}

function hostSelected(destHost: string, hosts: string[]): boolean {
  if (hosts.length === 0) return true;
  return hosts.some((host) => destHost === host || destHost.endsWith(`.${host}`));
}

function resetSocket(socket: Socket): void {
  if (typeof socket.resetAndDestroy === 'function') {
    socket.resetAndDestroy();
    return;
  }
  socket.destroy();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
