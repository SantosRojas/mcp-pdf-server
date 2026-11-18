import dns from 'node:dns/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

type Address = { address: string; family: number };

function ipv4ToNumbers(ip: string): number[] {
  return ip.split('.').map((part) => Number(part));
}

function blockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = ipv4ToNumbers(ip);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0) || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7);
      if (net.isIP(mapped) === 4) return blockedIp(mapped);
      const words = mapped.split(':');
      if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) {
        const high = Number.parseInt(words[0]!, 16);
        const low = Number.parseInt(words[1]!, 16);
        return blockedIp([high >> 8, high & 255, low >> 8, low & 255].join('.'));
      }
      return true;
    }
    // Unspecified/loopback/compatible, ULA, link-local, multicast, NAT64,
    // 6to4, Teredo and documentation prefixes are not useful public image origins.
    return normalized.startsWith('::') || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') ||
      normalized.startsWith('feb') || normalized.startsWith('fec') || normalized.startsWith('ff') || normalized.startsWith('64:ff9b:') ||
      normalized.startsWith('2002:') || normalized.startsWith('2001:0:') || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function resolvePublicAddress(rawHostname: string): Promise<Address> {
  const hostname = rawHostname.replace(/^\[|\]$/g, '');
  if (hostname.toLowerCase() === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError('Se bloqueó una URL local/privada por seguridad (SSRF).', 'IMAGE_URL_BLOCKED');
  }
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => blockedIp(item.address))) {
    throw new AppError('La URL de imagen resuelve a una dirección IP privada o reservada.', 'IMAGE_URL_BLOCKED');
  }
  return addresses[0] as Address;
}

function requestHttps(url: URL, pinned: Address): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const req = https.request(url, {
      method: 'GET',
      headers: { 'user-agent': 'mcp-pdf-server/1.0', accept: 'image/png,image/jpeg,image/webp,image/svg+xml' },
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
        callback(null, pinned.address, pinned.family);
      }) as never
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > config.imageMaxBytes) {
          req.destroy(new Error(`La imagen supera el límite de ${config.imageMaxBytes} bytes.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
      response.on('aborted', () => fail(new Error('La descarga de imagen se interrumpió antes de completarse.')));
      response.on('error', fail);
    });
    timer = setTimeout(() => req.destroy(new Error('Timeout descargando imagen.')), config.imageTimeoutMs);
    req.on('error', fail);
    req.end();
  });
}

async function downloadRemoteImage(rawUrl: string, redirects = 0): Promise<Buffer> {
  if (!config.allowRemoteImages) throw new AppError('Las imágenes remotas están deshabilitadas. Define PDF_MCP_ALLOW_REMOTE_IMAGES=true para habilitarlas.', 'REMOTE_IMAGES_DISABLED');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError('URL de imagen inválida.', 'INVALID_IMAGE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('Solo se aceptan URLs HTTPS sin credenciales.', 'INVALID_IMAGE_URL');
  const address = await resolvePublicAddress(url.hostname);
  const response = await requestHttps(url, address);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= 2) throw new AppError('La URL de imagen excedió el máximo de redirecciones.', 'IMAGE_REDIRECT_LIMIT');
    const location = response.headers.location;
    if (!location) throw new AppError('Redirección de imagen sin destino.', 'IMAGE_DOWNLOAD_FAILED');
    return downloadRemoteImage(new URL(location, url).toString(), redirects + 1);
  }
  if (response.status !== 200) throw new AppError(`No se pudo descargar la imagen (HTTP ${response.status}).`, 'IMAGE_DOWNLOAD_FAILED');
  const mime = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (!mime || !ALLOWED_MIME.has(mime)) throw new AppError(`Tipo MIME de imagen no permitido: ${mime || 'desconocido'}.`, 'IMAGE_MIME_REJECTED');
  return response.body;
}

async function readImageSource(source: string): Promise<Buffer> {
  if (source.startsWith('data:')) {
    const match = source.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) throw new AppError('Data URI de imagen inválido o MIME no permitido.', 'INVALID_IMAGE_DATA');
    const data = Buffer.from(match[2] ?? '', 'base64');
    if (data.length > config.imageMaxBytes) throw new AppError('La imagen Base64 supera el límite configurado.', 'IMAGE_TOO_LARGE');
    return data;
  }
  if (/^https?:\/\//i.test(source)) return downloadRemoteImage(source);
  if (path.isAbsolute(source) || source.split(/[\\/]/).includes('..')) throw new AppError('Las rutas de imagen deben ser relativas a PDF_MCP_ASSET_DIR y no pueden contener traversal.', 'INVALID_IMAGE_PATH');
  const root = await fs.realpath(config.assetDir);
  const candidate = path.resolve(root, source);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new AppError('La imagen escapa del directorio de activos permitido.', 'INVALID_IMAGE_PATH');
  const real = await fs.realpath(candidate).catch(() => { throw new AppError(`No se encontró el activo de imagen: ${source}`, 'IMAGE_NOT_FOUND'); });
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new AppError('El activo resuelve fuera del directorio permitido.', 'INVALID_IMAGE_PATH');
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > config.imageMaxBytes) throw new AppError('Activo de imagen no válido o demasiado grande.', 'IMAGE_TOO_LARGE');
  return fs.readFile(real);
}

export async function processImageSource(source: string): Promise<Buffer> {
  const raw = await readImageSource(source);
  const sourceText = raw.toString('utf8');
  if (/<svg[\s>]/i.test(sourceText)) {
    if (/<\s*(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY|\bon[a-z]+\s*=|(?:href|xlink:href)\s*=\s*['\"](?!#)|url\s*\(\s*['\"]?(?!#)|@import|@font-face/i.test(sourceText)) {
      throw new AppError('El SVG contiene scripts, referencias externas o construcciones no permitidas.', 'UNSAFE_SVG');
    }
  }
  const result = await sharp(raw, { limitInputPixels: 40_000_000, failOn: 'error' }).png({ compressionLevel: 9 }).toBuffer();
  if (result.byteLength > config.imageMaxBytes) throw new AppError('La imagen procesada supera el límite configurado.', 'IMAGE_TOO_LARGE');
  return result;
}

export function collectImageSources(nodes: unknown[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    if (record.type === 'Image' && typeof record.src === 'string') found.add(record.src);
    if (record.type === 'DocumentHeader' && typeof record.logoUrl === 'string') found.add(record.logoUrl);
    for (const child of Object.values(record)) visit(child);
  };
  nodes.forEach(visit);
  return [...found];
}

export async function prepareImages(nodes: unknown[]): Promise<{ images: Map<string, Buffer | null>; warnings: string[] }> {
  const sources = collectImageSources(nodes);
  if (sources.length > 40) throw new AppError('Un documento puede incluir como máximo 40 fuentes de imagen únicas.', 'IMAGE_COUNT_LIMIT');
  const images = new Map<string, Buffer | null>();
  const warnings: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < sources.length; index += 3) {
    const batch = sources.slice(index, index + 3);
    const processed = await Promise.all(batch.map(async (source) => {
      try { return { source, buffer: await processImageSource(source) }; }
      catch (error) { return { source, buffer: null, error }; }
    }));
    for (const item of processed) {
      if (item.buffer) {
        totalBytes += item.buffer.byteLength;
        if (totalBytes > 40 * 1024 * 1024) {
          images.set(item.source, null);
          warnings.push(`Imagen omitida (${item.source.slice(0, 120)}): se superó el límite agregado de 40 MiB por documento.`);
        } else images.set(item.source, item.buffer);
      } else {
        images.set(item.source, null);
        warnings.push(`Imagen omitida (${item.source.slice(0, 120)}): ${item.error instanceof Error ? item.error.message : String(item.error)}`);
      }
    }
  }
  return { images, warnings };
}
