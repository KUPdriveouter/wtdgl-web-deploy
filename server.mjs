import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPort = Number(process.env.PORT ?? 8080);
const defaultPublicRoot = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.data', 'application/octet-stream'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

function acceptsEncoding(header, encoding) {
  if (typeof header !== 'string') return false;
  let exact;
  let wildcard;
  for (const entry of header.split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    const qualityParameter = parameters.find(parameter => parameter.trim().startsWith('q='));
    const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
    const accepted = Number.isFinite(quality) && quality > 0;
    if (name === encoding) exact = accepted;
    else if (name === '*') wildcard = accepted;
  }
  return exact ?? wildcard ?? false;
}

function resolvePublicPath(publicRoot, pathname) {
  const relativeUrl = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  const filePath = resolve(join(publicRoot, relativeUrl));
  const relativeFilePath = relative(publicRoot, filePath);
  if (!relativeFilePath || relativeFilePath.startsWith('..') || isAbsolute(relativeFilePath)) {
    throw new Error('Path escapes the public directory.');
  }
  return { filePath, relativeUrl };
}

async function selectAsset(request, requestedFilePath, relativeUrl) {
  const isCompressibleBuildAsset = /^Build[/\\].*\.(data|framework\.js|wasm)$/i.test(relativeUrl);
  if (!isCompressibleBuildAsset) {
    return {
      filePath: requestedFilePath,
      contentEncoding: null,
      variesByEncoding: false,
      info: await stat(requestedFilePath)
    };
  }

  const compressedPath = `${requestedFilePath}.gz`;
  let compressedInfo = null;
  try {
    compressedInfo = await stat(compressedPath);
  } catch {
    // An uncompressed development build may be the only available variant.
  }
  if (compressedInfo) {
    if (acceptsEncoding(request.headers['accept-encoding'], 'gzip')) {
      return { filePath: compressedPath, contentEncoding: 'gzip', variesByEncoding: true, info: compressedInfo };
    }
    const notAcceptable = new Error('This build asset requires gzip support.');
    notAcceptable.statusCode = 406;
    throw notAcceptable;
  }
  return {
    filePath: requestedFilePath,
    contentEncoding: null,
    variesByEncoding: false,
    info: await stat(requestedFilePath)
  };
}

export function createRequestHandler({ publicRoot = defaultPublicRoot } = {}) {
  const resolvedPublicRoot = resolve(publicRoot);
  return async (request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }

    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      const pathname = decodeURIComponent(requestUrl.pathname);
      const { filePath: requestedFilePath, relativeUrl } = resolvePublicPath(resolvedPublicRoot, pathname);
      const selected = await selectAsset(request, requestedFilePath, relativeUrl);
      if (!selected.info.isFile()) throw new Error('Not a file.');

      let payload = null;
      let versionSuffix = '';
      if (relativeUrl === 'index.html') {
        let webAssembly;
        try {
          webAssembly = await stat(resolve(join(resolvedPublicRoot, 'Build', 'WebGLSmoke.wasm.gz')));
        } catch {
          webAssembly = await stat(resolve(join(resolvedPublicRoot, 'Build', 'WebGLSmoke.wasm')));
        }
        const buildVersion = `${webAssembly.size}-${Math.floor(webAssembly.mtimeMs)}`;
        const html = await readFile(selected.filePath, 'utf8');
        payload = html.replace(
          /WebGLSmoke\.(loader\.js|data|framework\.js|wasm)/g,
          assetUrl => `${assetUrl}?v=${buildVersion}`
        );
        versionSuffix = `-${buildVersion}`;
      }

      const contentLength = payload === null ? selected.info.size : Buffer.byteLength(payload);
      const etag = `W/\"${contentLength}-${Math.floor(selected.info.mtimeMs)}${versionSuffix}\"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304);
        response.end();
        return;
      }
      const responseHeaders = {
        'content-type': mimeTypes.get(extname(requestedFilePath).toLowerCase()) ?? 'application/octet-stream',
        'content-length': contentLength,
        'cache-control': relativeUrl === 'index.html'
          ? 'no-cache'
          : /^Build[/\\]/.test(relativeUrl) && requestUrl.searchParams.has('v')
            ? 'public, max-age=31536000, immutable'
            : /^Build[/\\]/.test(relativeUrl)
              ? 'no-cache'
              : 'public, max-age=3600',
        etag,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      };
      if (selected.contentEncoding !== null) {
        responseHeaders['content-encoding'] = selected.contentEncoding;
      }
      if (selected.variesByEncoding) {
        responseHeaders.vary = 'accept-encoding';
      }
      response.writeHead(200, responseHeaders);
      if (request.method === 'HEAD') response.end();
      else if (payload !== null) response.end(payload);
      else {
        const stream = createReadStream(selected.filePath);
        stream.on('error', () => response.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      const statusCode = error?.statusCode === 406 ? 406 : 404;
      const headers = { 'content-type': 'text/plain; charset=utf-8' };
      if (statusCode === 406) headers.vary = 'accept-encoding';
      response.writeHead(statusCode, headers);
      response.end(statusCode === 406 ? 'A gzip-capable client is required.' : 'Not found');
    }
  };
}

export function createWebServer(options) {
  return createServer(createRequestHandler(options));
}

function start() {
  const server = createWebServer();
  server.listen(defaultPort, '0.0.0.0', () => {
    console.log(`[WTDGL Web] http://0.0.0.0:${defaultPort}`);
  });

  function shutdown() {
    server.close(error => {
      if (error) process.exitCode = 1;
    });
    server.closeIdleConnections?.();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === resolve(fileURLToPath(import.meta.url))) start();
