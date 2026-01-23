import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://mcp.tavily.com/mcp/';
const PORT = Number(process.env.PORT ?? 8787);
const BASE_URL = process.env.TAVILY_MCP_BASE_URL ?? DEFAULT_BASE_URL;
const KEYS_FILE =
  process.env.KEYS_FILE ?? path.join(process.cwd(), 'keys.json');
const MAX_BODY_BYTES = resolveMaxBytes('MAX_BODY_BYTES', 1024 * 1024);
const MAX_ERROR_BODY_BYTES = resolveMaxBytes('MAX_ERROR_BODY_BYTES', 256 * 1024);

let cachedKeys: string[] = [];
let currentKeyIndex = 0;

type KeysFile = string[];

function resolveMaxBytes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

function normalizeKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error('keys.json must be a JSON array of API keys.');
  }

  const keys = raw
    .map((key) => (typeof key === 'string' ? key.trim() : ''))
    .filter((key) => key.length > 0);

  if (keys.length === 0) {
    throw new Error('keys.json does not contain any usable API keys.');
  }

  return keys;
}

async function reloadKeys(reason: string): Promise<void> {
  try {
    const contents = await fs.readFile(KEYS_FILE, 'utf8');
    const parsed = JSON.parse(contents) as KeysFile;
    const keys = normalizeKeys(parsed);
    cachedKeys = keys;
    currentKeyIndex = 0;
    console.info(`[proxy] keys reloaded (${keys.length}) reason=${reason}`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to reload API keys.';
    console.error(`[proxy] keys reload failed (${reason}): ${message}`);
  }
}

function nextKey(): string {
  if (cachedKeys.length === 0) {
    throw new Error('No API keys available.');
  }
  const key = cachedKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % cachedKeys.length;
  return key;
}

function watchKeysFile(): void {
  const watchDir = path.dirname(KEYS_FILE);
  const watchFile = path.basename(KEYS_FILE);
  try {
    fsSync.watch(watchDir, (eventType, filename) => {
      if (!filename || filename.toString() !== watchFile) {
        return;
      }
      void reloadKeys(`fs.watch:${eventType}`);
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to watch keys file.';
    console.error(`[proxy] keys watch failed: ${message}`);
  }
}

function buildUpstreamUrl(reqUrl: string, key: string): URL {
  const base = new URL(BASE_URL);
  const incoming = new URL(reqUrl, 'http://localhost');
  const upstream = new URL(base.origin);

  upstream.pathname =
    incoming.pathname === '/' ? base.pathname : incoming.pathname;
  upstream.search = incoming.search;
  upstream.searchParams.set('tavilyApiKey', key);

  return upstream;
}

function safeUpstreamUrl(url: URL): string {
  const safe = new URL(url.toString());
  if (safe.searchParams.has('tavilyApiKey')) {
    safe.searchParams.set('tavilyApiKey', 'REDACTED');
  }
  return safe.toString();
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

function connectionHeaderTokens(headers: http.IncomingHttpHeaders): Set<string> {
  const connectionHeader = headers['connection'];
  if (!connectionHeader) {
    return new Set();
  }
  const combined = Array.isArray(connectionHeader)
    ? connectionHeader.join(',')
    : connectionHeader;
  const tokens = combined
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

function stripHopByHopHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const filtered: http.OutgoingHttpHeaders = {};
  const connectionTokens = connectionHeaderTokens(headers);
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey) || connectionTokens.has(lowerKey)) {
      continue;
    }
    filtered[lowerKey] = value;
  }
  return filtered;
}

function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  bodyLength: number,
): http.OutgoingHttpHeaders {
  const filtered = stripHopByHopHeaders(headers);
  delete filtered['host'];
  if (bodyLength > 0) {
    filtered['content-length'] = String(bodyLength);
  } else {
    delete filtered['content-length'];
  }
  return filtered;
}

type AttemptResult = {
  ok: boolean;
  statusCode?: number;
  statusMessage?: string;
  headers?: http.IncomingHttpHeaders;
  body?: Buffer;
  bodyTruncated?: boolean;
  error?: Error;
};

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const KEY_RELATED_STATUS = new Set([401, 403, 429]);
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

function shouldRetryStatus(statusCode: number, method: string): boolean {
  if (KEY_RELATED_STATUS.has(statusCode)) {
    return true;
  }
  if (!IDEMPOTENT_METHODS.has(method)) {
    return false;
  }
  return RETRYABLE_STATUS.has(statusCode);
}

function shouldRetryError(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method);
}

async function readRequestBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        const error = new Error(
          `Request body exceeds ${maxBytes} bytes.`,
        ) as Error & { code?: string };
        error.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('aborted', () => {
      reject(new Error('Client aborted'));
    });
  });
}

async function attemptUpstreamRequest(options: {
  upstreamUrl: URL;
  upstreamInfo: string;
  body: Buffer;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestInfo: string;
  requestStart: number;
  setActiveRequest: (req: http.ClientRequest | null) => void;
}): Promise<AttemptResult> {
  const {
    upstreamUrl,
    upstreamInfo,
    body,
    req,
    res,
    requestInfo,
    requestStart,
    setActiveRequest,
  } = options;

  return await new Promise((resolve) => {
    const client = upstreamUrl.protocol === 'https:' ? https : http;
    const upstreamReq = client.request(
      upstreamUrl,
      {
        method: req.method,
        headers: buildUpstreamHeaders(req.headers, body.length),
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 0;
        if (!isSuccessStatus(statusCode)) {
          const chunks: Buffer[] = [];
          let total = 0;
          let bodyTruncated = false;
          upstreamRes.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (total >= MAX_ERROR_BODY_BYTES) {
              bodyTruncated = true;
              return;
            }
            const remaining = MAX_ERROR_BODY_BYTES - total;
            if (buffer.length > remaining) {
              chunks.push(buffer.subarray(0, remaining));
              total = MAX_ERROR_BODY_BYTES;
              bodyTruncated = true;
              return;
            }
            chunks.push(buffer);
            total += buffer.length;
          });
          upstreamRes.on('end', () => {
            setActiveRequest(null);
            resolve({
              ok: false,
              statusCode,
              statusMessage: upstreamRes.statusMessage,
              headers: upstreamRes.headers,
              body: Buffer.concat(chunks),
              bodyTruncated,
            });
          });
          upstreamRes.on('error', (error) => {
            setActiveRequest(null);
            resolve({ ok: false, error });
          });
          return;
        }

        const durationMs = Date.now() - requestStart;
        console.info(
          `[proxy] ${requestInfo} -> ${upstreamInfo} ${statusCode} ${durationMs}ms`,
        );
        const responseHeaders = stripHopByHopHeaders(upstreamRes.headers);
        res.writeHead(statusCode, upstreamRes.statusMessage, responseHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          setActiveRequest(null);
        });
        resolve({ ok: true, statusCode });
      },
    );

    upstreamReq.on('error', (error) => {
      setActiveRequest(null);
      resolve({ ok: false, error });
    });

    setActiveRequest(upstreamReq);
    if (body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    console.error(
      `[proxy] ${req.method ?? 'GET'} <missing-url> -> error: missing request url`,
    );
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing request URL.');
    return;
  }

  const requestStart = Date.now();
  const method = req.method ?? 'GET';
  const requestInfo = `${method} ${req.url}`;

  let activeUpstreamReq: http.ClientRequest | null = null;
  let clientAborted = false;

  req.on('aborted', () => {
    clientAborted = true;
    if (activeUpstreamReq) {
      activeUpstreamReq.destroy();
    }
    console.warn(`[proxy] ${requestInfo} -> aborted by client`);
  });

  let body: Buffer;
  try {
    body = await readRequestBody(req, MAX_BODY_BYTES);
  } catch (error) {
    const err = error as Error & { code?: string };
    const message = err?.message ?? 'Failed to read request body.';
    if (!clientAborted) {
      console.error(`[proxy] ${requestInfo} -> error: ${message}`);
      const statusCode = err?.code === 'BODY_TOO_LARGE' ? 413 : 400;
      res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    }
    return;
  }

  try {
    if (cachedKeys.length === 0) {
      await reloadKeys('on-demand');
    }
    if (cachedKeys.length === 0) {
      throw new Error('No API keys available.');
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load API keys.';
    console.error(`[proxy] ${requestInfo} -> error: ${message}`);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(message);
    return;
  }

  const totalAttempts = cachedKeys.length;
  let lastFailure: AttemptResult | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    if (clientAborted) {
      return;
    }

    let upstreamUrl: URL;
    try {
      const key = nextKey();
      upstreamUrl = buildUpstreamUrl(req.url, key);
    } catch (error) {
      console.error(
        `[proxy] ${requestInfo} -> error: failed to build upstream url`,
      );
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Failed to build upstream URL.');
      return;
    }

    const upstreamInfo = safeUpstreamUrl(upstreamUrl);
    const result = await attemptUpstreamRequest({
      upstreamUrl,
      upstreamInfo,
      body,
      req,
      res,
      requestInfo,
      requestStart,
      setActiveRequest: (nextRequest) => {
        activeUpstreamReq = nextRequest;
      },
    });

    if (result.ok) {
      return;
    }

    lastFailure = result;

    if (result.error) {
      console.error(
        `[proxy] ${requestInfo} -> ${upstreamInfo} attempt ${attempt}/${totalAttempts} error: ${result.error.message}`,
      );
      if (!shouldRetryError(method)) {
        break;
      }
    } else {
      const statusCode = result.statusCode ?? 0;
      console.warn(
        `[proxy] ${requestInfo} -> ${upstreamInfo} attempt ${attempt}/${totalAttempts} status ${
          statusCode
        }`,
      );
      if (result.bodyTruncated) {
        console.warn(
          `[proxy] ${requestInfo} -> ${upstreamInfo} error body truncated`,
        );
      }
      if (!statusCode || !shouldRetryStatus(statusCode, method)) {
        break;
      }
    }
  }

  if (clientAborted) {
    return;
  }

  if (lastFailure?.error) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`Upstream request failed: ${lastFailure.error.message}`);
    return;
  }

  if (lastFailure?.statusCode) {
    const responseHeaders = lastFailure.headers
      ? stripHopByHopHeaders(lastFailure.headers)
      : {};
    if (
      lastFailure.body &&
      lastFailure.body.length > 0 &&
      !lastFailure.bodyTruncated
    ) {
      responseHeaders['content-length'] = String(lastFailure.body.length);
      res.writeHead(
        lastFailure.statusCode,
        lastFailure.statusMessage,
        responseHeaders,
      );
      res.end(lastFailure.body);
    } else {
      const message = `Upstream request failed with status ${lastFailure.statusCode}`;
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-type'];
      responseHeaders['content-type'] = 'text/plain; charset=utf-8';
      responseHeaders['content-length'] = String(Buffer.byteLength(message));
      res.writeHead(
        lastFailure.statusCode,
        lastFailure.statusMessage,
        responseHeaders,
      );
      res.end(message);
    }
    return;
  }

  res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Upstream request failed.');
});

server.on('clientError', (_err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
});

async function start(): Promise<void> {
  await reloadKeys('startup');
  watchKeysFile();
  server.listen(PORT, () => {
    console.info(`tavily-proxy listening on http://localhost:${PORT}`);
    console.info(`Upstream: ${BASE_URL}`);
    console.info(`Keys file: ${KEYS_FILE}`);
  });
}

start().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`[proxy] failed to start: ${message}`);
  process.exitCode = 1;
});
