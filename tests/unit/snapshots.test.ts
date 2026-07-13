import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Redirect USER_CONFIG_DIR by setting HOME BEFORE importing the module under test.
// os.homedir() reads $HOME on POSIX; the module resolves SNAPSHOTS_DIR at load time
// via path.join(os.homedir(), '.config', 'namecheap-mcp', 'snapshots').
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'namecheap-mcp-test-'));
process.env['HOME'] = testHome;

const { writeSnapshot, listSnapshots, readSnapshot, pruneSnapshots, SNAPSHOTS_DIR } =
  await import('../../src/snapshots.js');

describe('snapshots', () => {
  beforeEach(() => {
    if (fs.existsSync(SNAPSHOTS_DIR)) {
      fs.rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(SNAPSHOTS_DIR)) {
      fs.rmSync(SNAPSHOTS_DIR, { recursive: true, force: true });
    }
  });

  it('writes a snapshot file at 0600 in the expected dir', () => {
    const p = writeSnapshot({
      domain: 'example.com',
      writtenBy: 'test',
      emailType: 'MX',
      usingNamecheapDns: true,
      hosts: [{ hostName: '@', recordType: 'A', address: '1.2.3.4', ttl: 1800 }],
      rawResponse: { DomainDNSGetHostsResult: { '@_Domain': 'example.com' } },
    });

    expect(p).toBeTruthy();
    expect(p!.startsWith(SNAPSHOTS_DIR)).toBe(true);
    expect(fs.existsSync(p!)).toBe(true);
    if (process.platform !== 'win32') {
      const stat = fs.statSync(p!);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('round-trips via readSnapshot', () => {
    const p = writeSnapshot({
      domain: 'example.com',
      writtenBy: 'test',
      emailType: 'NONE',
      usingNamecheapDns: false,
      hosts: [{ hostName: 'mail', recordType: 'MX', address: 'mx.example.com.', mxPref: 10, ttl: 1800 }],
      rawResponse: {},
    })!;
    const snap = readSnapshot(p);
    expect(snap.version).toBe(1);
    expect(snap.domain).toBe('example.com');
    expect(snap.hosts).toHaveLength(1);
    expect(snap.hosts[0].mxPref).toBe(10);
  });

  it('lists snapshots newest first and only for the requested domain', async () => {
    writeSnapshot({ domain: 'a.com', writtenBy: 'x', emailType: '', usingNamecheapDns: true, hosts: [], rawResponse: {} });
    await new Promise((r) => setTimeout(r, 5));
    writeSnapshot({ domain: 'a.com', writtenBy: 'x', emailType: '', usingNamecheapDns: true, hosts: [], rawResponse: {} });
    writeSnapshot({ domain: 'b.com', writtenBy: 'x', emailType: '', usingNamecheapDns: true, hosts: [], rawResponse: {} });

    const aSnaps = listSnapshots('a.com');
    expect(aSnaps.length).toBe(2);
    expect(aSnaps[0].takenAt >= aSnaps[1].takenAt).toBe(true);

    const bSnaps = listSnapshots('b.com');
    expect(bSnaps.length).toBe(1);

    const other = listSnapshots('never-used.com');
    expect(other.length).toBe(0);
  });

  it('does not match on substring (example.com does not match example.co)', () => {
    writeSnapshot({ domain: 'example.com', writtenBy: 'x', emailType: '', usingNamecheapDns: true, hosts: [], rawResponse: {} });
    expect(listSnapshots('example.co')).toHaveLength(0);
    expect(listSnapshots('example.com')).toHaveLength(1);
  });

  it('pruneSnapshots keeps only the N most recent', async () => {
    for (let i = 0; i < 5; i++) {
      writeSnapshot({
        domain: 'big.com',
        writtenBy: `write-${i}`,
        emailType: '',
        usingNamecheapDns: true,
        hosts: [],
        rawResponse: {},
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    pruneSnapshots('big.com', 2);
    const remaining = listSnapshots('big.com');
    expect(remaining).toHaveLength(2);
    // Must be the two NEWEST (writtenBy write-4 and write-3).
    expect(remaining[0].writtenBy).toBe('write-4');
    expect(remaining[1].writtenBy).toBe('write-3');
  });

  it('sanitizes domain for filename — no path escape from SNAPSHOTS_DIR', () => {
    const p = writeSnapshot({
      domain: '../evil.com',
      writtenBy: 'test',
      emailType: '',
      usingNamecheapDns: true,
      hosts: [],
      rawResponse: {},
    });
    expect(p).toBeTruthy();
    // The `..` as bytes within a single filename segment is harmless — only
    // `/` or `\` would allow escaping the directory. Confirm the resolved
    // directory is still SNAPSHOTS_DIR, which is the real safety property.
    expect(path.dirname(p!)).toBe(SNAPSHOTS_DIR);
    expect(path.basename(p!).includes('/')).toBe(false);
    expect(path.basename(p!).includes('\\')).toBe(false);
  });

  it('readSnapshot throws on unknown version', () => {
    const badPath = path.join(SNAPSHOTS_DIR, 'example.com__bad.json');
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(badPath, JSON.stringify({ version: 999, domain: 'example.com', hosts: [] }));
    expect(() => readSnapshot(badPath)).toThrow(/version 999/);
  });
});
