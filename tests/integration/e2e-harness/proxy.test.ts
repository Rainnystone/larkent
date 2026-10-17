import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { startFaultProxy } from '../../../e2e/test-bridge/proxy';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 15_000);

describe('test-bridge fault proxy', () => {
  it('disconnect resets the tunneled socket with ECONNRESET', { timeout: 15_000 }, async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'disconnect' });
    cleanups.push(() => proxy.close());

    await expect(connectThroughProxy(proxy.url, target)).rejects.toSatisfy((err: unknown) => {
      expect(['ECONNRESET', 'EPIPE', 'ECONNABORTED']).toContain(errorCode(err));
      return true;
    });
  });

  it('blackhole never completes CONNECT so the client times out', async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'blackhole' });
    cleanups.push(() => proxy.close());

    await expect(connectThroughProxy(proxy.url, target, 400)).rejects.toSatisfy((err: unknown) => {
      expect(String(err)).toMatch(/timeout|ETIMEDOUT|ETIMEOUT/i);
      return true;
    });
  });

  it('eproto poisons the TLS handshake', { timeout: 10_000 }, async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'eproto' });
    cleanups.push(() => proxy.close());

    await expect(connectThroughProxy(proxy.url, target)).rejects.toSatisfy((err: unknown) => {
      const code = errorCode(err);
      expect(
        code === 'EPROTO' || code.startsWith('ERR_SSL_') || /ssl|tls|protocol/i.test(String(err)),
      ).toBe(true);
      return true;
    });
  });

  it('eai_again is simulated with an unresolvable proxy host', async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'eai_again' });
    cleanups.push(() => proxy.close());

    await expect(connectThroughProxy(proxy.url, target, 800)).rejects.toSatisfy((err: unknown) => {
      const code = errorCode(err);
      const text = String(err);
      // Some resolvers surface NXDOMAIN immediately; others stall until the
      // client CONNECT timer fires. Both are the unresolvable-host path.
      expect(
        code === 'EAI_AGAIN'
        || code === 'ENOTFOUND'
        || code === 'ETIMEDOUT'
        || code === 'ETIMEOUT'
        || /timeout|ENOTFOUND|EAI_AGAIN/i.test(text),
      ).toBe(true);
      return true;
    });
  });

  it('applies disconnect only to selected hosts', async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'disconnect', hosts: ['open.feishu.cn'] });
    cleanups.push(() => proxy.close());

    const body = await connectThroughProxy(proxy.url, target, 5_000);
    expect(body).toContain('ok');
  });

  it('slow delays CONNECT completion', { timeout: 10_000 }, async () => {
    const target = await localHttpsTarget();
    const proxy = await startFaultProxy({ mode: 'slow', delayMs: 250 });
    cleanups.push(() => proxy.close());

    const started = Date.now();
    const body = await connectThroughProxy(proxy.url, target, 5_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(body).toContain('ok');
  });
});

async function localHttpsTarget(): Promise<{ host: string; port: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'e2e-proxy-cert-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const { cert, key } = createSelfSigned(dir);
  const server: HttpsServer = createHttpsServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('https target did not bind');
  return { host: '127.0.0.1', port: address.port };
}

function createSelfSigned(dir: string): { cert: string; key: string } {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=127.0.0.1',
  ]);
  return {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
  };
}

function connectThroughProxy(
  proxyUrl: string,
  target: { host: string; port: number },
  timeoutMs = 2_000,
): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
    });
    const finish = (err: Error | undefined, body?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      if (err) reject(err);
      else resolve(body ?? '');
    };
    const timer = setTimeout(() => {
      const err = new Error('proxy CONNECT timeout');
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      finish(err);
    }, timeoutMs);
    req.on('error', (err) => finish(err));
    req.on('connect', (_res, socket) => {
      const tls = tlsConnect({
        socket,
        host: target.host,
        servername: 'localhost',
        rejectUnauthorized: false,
      });
      let body = '';
      tls.setEncoding('utf8');
      tls.on('error', (err) => finish(err));
      tls.on('data', (chunk: string) => {
        body += chunk;
      });
      tls.on('end', () => {
        if (!body) {
          const err = new Error('tunneled socket closed');
          (err as NodeJS.ErrnoException).code = 'ECONNRESET';
          finish(err);
          return;
        }
        finish(undefined, body);
      });
      tls.on('secureConnect', () => {
        tls.write(`GET / HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      });
    });
    req.end();
  });
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return '';
}
