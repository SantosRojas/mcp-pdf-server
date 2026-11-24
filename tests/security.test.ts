import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { isBlockedIpAddress } from '../src/engine/imageProcessor.js';
import { serializeQpdfArgFile } from '../src/utils/qpdf.js';
import { applyPdfSecurity } from '../src/tools/securityPdf.js';
import { buildWorkspace } from '../src/runtime/workspace.js';
import { SessionRegistry } from '../src/transports/http.js';

test('isBlockedIpAddress blocks compressed Teredo, site-local fed0..feff, discard, cloud metadata, and uncompressed IPv6 loopback while allowing public IPs', () => {
  const blocked = [
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:1.1.1.1',
    '::ffff:0:127.0.0.1',
    'fe80::1%eth0',
    '2001::1:0:0:1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    'fed0::1',
    'feff::1',
    '100::1',
    '2001:2::1',
    '64:ff9b:1::1'
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIpAddress(ip), true, `Expected ${ip} to be blocked`);
  }

  const allowed = [
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2606:2800:220:1:248:1893:25c8:1946'
  ];
  for (const ip of allowed) {
    assert.equal(isBlockedIpAddress(ip), false, `Expected ${ip} to be allowed`);
  }
});

test('serializeQpdfArgFile formats stdin argument lines and rejects newline/null injection', () => {
  const payload = serializeQpdfArgFile(['--encrypt', '', 'ownerSecret!', '256', '--', '/tmp/in.pdf', '/tmp/out.pdf']);
  assert.equal(payload, '--encrypt\n\nownerSecret!\n256\n--\n/tmp/in.pdf\n/tmp/out.pdf\n');
  assert.throws(
    () => serializeQpdfArgFile(['--encrypt', 'bad\n--replace-input', 'owner']),
    (err: unknown) => (err as { code?: string }).code === 'QPDF_INVALID_ARGUMENT'
  );
  assert.throws(
    () => serializeQpdfArgFile(['--encrypt', 'bad\0null', 'owner']),
    (err: unknown) => (err as { code?: string }).code === 'QPDF_INVALID_ARGUMENT'
  );
});

test('applyPdfSecurity encrypts PDF via qpdf @- stdin without exposing passwords on CLI and preserves unencrypted metadata flow', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-pdf-sec-'));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const inputPath = path.join(tmpDir, 'source.pdf');
    await fs.writeFile(inputPath, await pdf.save());
    const workspace = buildWorkspace([tmpDir], { outputDirSetting: tmpDir, extraAllowedDirs: [], allowAnyPath: false });

    const metaOnly = await applyPdfSecurity({
      filePath: inputPath,
      outputFilename: 'meta-only.pdf',
      overwrite: true,
      metadata: { title: 'Clean Metadata' },
      permissions: { printing: true, copying: true }
    }, workspace);
    assert.equal(metaOnly.encrypted, false);

    const secured = await applyPdfSecurity({
      filePath: inputPath,
      outputFilename: 'encrypted.pdf',
      overwrite: true,
      userPassword: '',
      ownerPassword: '--Owner#Pass!2026',
      permissions: { printing: false, copying: false }
    }, workspace);
    assert.equal(secured.encrypted, true);
    const outBytes = await fs.readFile(String(secured.path));
    assert.equal(outBytes.subarray(0, 5).toString('ascii'), '%PDF-');
    await assert.rejects(() => PDFDocument.load(outBytes, { ignoreEncryption: false }));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('SessionRegistry evicts idle HTTP MCP sessions past TTL while retaining active sessions', async () => {
  let closedIds: string[] = [];
  const registry = new SessionRegistry<string>({
    maxSessions: 2,
    ttlMs: 1_000,
    onClose: async (id) => { closedIds.push(id); }
  });

  registry.set('s1', 'session-1', 1_000);
  assert.equal(registry.tryReserveSlot(1_200), true);
  assert.equal(registry.tryReserveSlot(1_200), false);
  registry.releaseSlot();
  registry.set('s2', 'session-2', 1_500);
  assert.equal(registry.canAccept(1_800), false);

  // Touch s2 at t=1900 so only s1 expires by t=2100.
  assert.equal(registry.get('s2', 1_900), 'session-2');
  assert.equal(registry.canAccept(2_100), true);
  assert.equal(registry.get('s1', 2_100), undefined);
  assert.equal(registry.get('s2', 2_100), 'session-2');
  assert.deepEqual(closedIds, ['s1']);
});
