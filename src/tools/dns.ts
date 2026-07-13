import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NamecheapClient } from '../client.js';
import { HostRecord, RecordType } from '../types.js';
import { requireClient } from '../config.js';
import { toErrorResult } from '../errors.js';
import { writeSnapshot, listSnapshots, readSnapshot, SNAPSHOTS_DIR } from '../snapshots.js';
import { parseGetHostsResponse, type ParsedHostsResponse, type RawHost } from '../parse.js';
import { recordMatches } from '../dns-matching.js';

const RECORD_TYPES = [
  'A',
  'AAAA',
  'ALIAS',
  'CAA',
  'CNAME',
  'FRAME',
  'MX',
  'MXE',
  'NS',
  'TXT',
  'URL',
  'URL301',
] as const satisfies readonly RecordType[];

// Wrap parseGetHostsResponse so that on failure we stderr-log the last raw XML
// body that the client received. Gated on NAMECHEAP_DEBUG=1 to keep stderr
// clean in normal operation. This is the fast path when a future API schema
// shift breaks the strict parser — the full body is captured instead of
// requiring a curl re-run against the live endpoint.
function parseHostsWithDebug(
  result: unknown,
  client: NamecheapClient,
): ParsedHostsResponse {
  try {
    return parseGetHostsResponse(result);
  } catch (err) {
    if (process.env['NAMECHEAP_DEBUG'] === '1') {
      const raw = client.lastRawResponse ?? '';
      const tail = raw.length > 2048 ? raw.slice(-2048) : raw;
      process.stderr.write(
        `[namecheap-mcp] parseGetHostsResponse failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `[namecheap-mcp] last ${tail.length} bytes of raw XML:\n${tail}\n`,
      );
    }
    throw err;
  }
}

function cleanHostsForOutput(parsed: ParsedHostsResponse, rawHosts: RawHost[]): {
  domain: string;
  usingNamecheapDns: boolean;
  emailType: string;
  hosts: unknown[];
} {
  return {
    domain: parsed.domain,
    usingNamecheapDns: parsed.usingNamecheapDns,
    emailType: parsed.emailType,
    hosts: rawHosts.map((h) => ({
      id: h['@_HostId'],
      name: h['@_Name'],
      type: h['@_Type'],
      address: h['@_Address'],
      ttl: parseInt(h['@_TTL'] ?? '1800', 10),
      mxPref: parseInt(h['@_MXPref'] ?? '0', 10),
      active: h['@_IsActive'] === 'true',
    })),
  };
}

export function registerDnsTools(server: McpServer, getClient: () => NamecheapClient | null): void {

  server.registerTool(
    'get_dns_hosts',
    {
      description: 'Get all DNS host records for a domain (A, AAAA, CNAME, MX, TXT, NS, etc.). Automatically writes a local snapshot to ~/.config/namecheap-mcp/snapshots/ as a free backup.',
      inputSchema: { domainName: z.string().describe('The domain name, e.g. "example.com"') },
    },
    async ({ domainName }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);
        const result = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const parsed = parseHostsWithDebug(result, client);
        writeSnapshot({
          domain: domainName,
          writtenBy: 'get_dns_hosts',
          emailType: parsed.emailType,
          usingNamecheapDns: parsed.usingNamecheapDns,
          hosts: parsed.hosts,
          rawResponse: result,
        });
        return { content: [{ type: 'text', text: JSON.stringify(cleanHostsForOutput(parsed, parsed.raw), null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'set_dns_hosts',
    {
      description:
        'DO NOT USE FOR SINGLE-RECORD CHANGES. Use `update_dns_record` to add, update, or delete one record safely.\n\n' +
        'This tool REPLACES the entire DNS zone with the provided list. Every record not included will be DELETED. ' +
        'Gated: requires `confirmReplaceAll: true` AND `expectedDeletions` matching a pre-write diff against the current zone. ' +
        'A snapshot of the pre-write state is written to ~/.config/namecheap-mcp/snapshots/ for manual restore if needed.',
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        hosts: z.array(z.object({
          hostName: z.string().describe('Host/subdomain name. Use "@" for root, "*" for wildcard.'),
          recordType: z.enum(RECORD_TYPES).describe('DNS record type'),
          address: z.string().describe('Record value (IP address, hostname, or URL)'),
          mxPref: z.number().int().min(0).max(65535).optional().describe('MX priority (required for MX records, 0–65535)'),
          ttl: z.number().int().optional().describe('TTL in seconds (default: 1800)'),
        }).refine(
          (r) => r.recordType !== 'MX' || r.mxPref !== undefined,
          { error: 'mxPref is required for MX records', path: ['mxPref'] }
        )).describe('Complete list of DNS records to set. Replaces all existing records.'),
        confirmReplaceAll: z.literal(true).describe(
          'Must be exactly `true` to acknowledge this call replaces the entire zone and deletes any record not in `hosts`.'
        ),
        expectedDeletions: z.number().int().min(0).describe(
          'The number of currently existing records you expect this call to delete. ' +
          'The tool reads the current zone and refuses if the actual deletion count does not match. ' +
          'Set to 0 if you are supplying the full list of records that should remain.'
        ),
        preserveEmailType: z.boolean().optional().describe(
          'If true (default), reads the current EmailType from the zone and passes it through. Set to false to reset.'
        ),
      },
    },
    async ({ domainName, hosts, expectedDeletions, preserveEmailType }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);

        const current = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const parsed = parseHostsWithDebug(current, client);

        const snapshotPath = writeSnapshot({
          domain: domainName,
          writtenBy: 'set_dns_hosts:pre-write',
          emailType: parsed.emailType,
          usingNamecheapDns: parsed.usingNamecheapDns,
          hosts: parsed.hosts,
          rawResponse: current,
        });

        const key = (h: HostRecord) => `${h.hostName}\x00${h.recordType}\x00${h.address}`;
        const newKeys = new Set(hosts.map(key));
        const actualDeletions = parsed.hosts.filter((h) => !newKeys.has(key(h))).length;
        if (actualDeletions !== expectedDeletions) {
          return {
            isError: true,
            structuredContent: {
              errorCode: 'DELETION_COUNT_MISMATCH',
              expectedDeletions,
              actualDeletions,
              currentRecordCount: parsed.hosts.length,
              newRecordCount: hosts.length,
              snapshotPath,
            },
            content: [{
              type: 'text',
              text:
                `Refusing to write: expectedDeletions=${expectedDeletions} but this call would actually delete ${actualDeletions} existing records. ` +
                `Current zone has ${parsed.hosts.length} records; you provided ${hosts.length}. ` +
                `Pre-write snapshot preserved at ${snapshotPath ?? '(snapshot write failed)'}. ` +
                `If you truly want to delete ${actualDeletions} records, set expectedDeletions=${actualDeletions} and retry. ` +
                `For single-record changes, use update_dns_record instead.`,
            }],
          };
        }

        const hostParams = client.flattenHostRecords(hosts as HostRecord[]);
        const extraParams: Record<string, string> = {};
        if (preserveEmailType !== false && parsed.emailType) {
          extraParams['EmailType'] = parsed.emailType;
        }
        await client.execute(
          'namecheap.domains.dns.setHosts',
          { SLD: sld, TLD: tld, ...extraParams, ...hostParams },
          'POST'
        );

        // Post-write verification.
        const postWriteRaw = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const postWrite = parseHostsWithDebug(postWriteRaw, client);
        writeSnapshot({
          domain: domainName,
          writtenBy: 'set_dns_hosts:post-write',
          emailType: postWrite.emailType,
          usingNamecheapDns: postWrite.usingNamecheapDns,
          hosts: postWrite.hosts,
          rawResponse: postWriteRaw,
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              domain: domainName,
              previousRecordCount: parsed.hosts.length,
              newRecordCount: postWrite.hosts.length,
              deletedCount: actualDeletions,
              snapshotPath,
              countsMatch: postWrite.hosts.length === hosts.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'update_dns_record',
    {
      description:
        'Safely adds, updates, or removes a single DNS record without affecting other records. ' +
        'Performs an internal read-modify-write — no need to call get_dns_hosts first. ' +
        'For upsert: finds a matching record by hostName + recordType (MX, TXT, CAA, and NS also match on address so multi-valued records at the same host do not clobber each other) and replaces it, or appends if not found. ' +
        'For delete: removes the matching record. ' +
        'Writes pre-write and post-write snapshots to ~/.config/namecheap-mcp/snapshots/ for recovery. ' +
        'Refuses by default when the read of current records returns an empty set on a zone that uses Namecheap DNS (set allowEmptyBaseline:true to override — only use for a freshly-provisioned empty zone).',
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        operation: z.enum(['upsert', 'delete']).describe('"upsert" to add or update a record, "delete" to remove it'),
        record: z.object({
          hostName: z.string().describe('Host/subdomain name. Use "@" for root, "*" for wildcard.'),
          recordType: z.enum(RECORD_TYPES).describe('DNS record type'),
          address: z.string().optional().describe('Record value (required for upsert)'),
          mxPref: z.number().int().min(0).max(65535).optional().describe('MX priority (required for MX upsert)'),
          ttl: z.number().int().optional().describe('TTL in seconds (default: 1800)'),
        }).describe('The record to add, update, or delete'),
        allowEmptyBaseline: z.boolean().optional().describe(
          'Set to true to proceed when the current zone has 0 records AND is using Namecheap DNS. ' +
          'By default this is refused because it almost always indicates a parse/API failure that would wipe the zone on write. ' +
          'Only set true if you are certain the zone is legitimately empty (e.g. freshly provisioned).'
        ),
        confirmMutation: z.literal(true).describe('Must be true to approve this DNS mutation.'),
      },
    },
    async ({ domainName, operation, record, allowEmptyBaseline }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);

        if (operation === 'upsert' && !record.address) {
          return { content: [{ type: 'text', text: 'Error: address is required for upsert' }], isError: true };
        }
        if (operation === 'upsert' && record.recordType === 'MX' && record.mxPref === undefined) {
          return { content: [{ type: 'text', text: 'Error: mxPref is required for MX upsert' }], isError: true };
        }

        const existingRaw = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const parsed = parseHostsWithDebug(existingRaw, client);
        const currentRecords = parsed.hosts;

        // Empty-baseline guard: the single biggest wipe vector.
        if (currentRecords.length === 0 && parsed.usingNamecheapDns && !allowEmptyBaseline) {
          return {
            isError: true,
            structuredContent: {
              errorCode: 'EMPTY_BASELINE_REFUSED',
              domain: domainName,
              usingNamecheapDns: parsed.usingNamecheapDns,
            },
            content: [{
              type: 'text',
              text:
                `Refusing to write: getHosts returned 0 records but this zone is using Namecheap DNS. ` +
                `This almost always indicates a parse or API failure that would wipe the zone if we proceeded. ` +
                `If the zone is legitimately empty (e.g. you just provisioned it), retry with allowEmptyBaseline:true. ` +
                `Otherwise, investigate why getHosts returned no records before writing.`,
            }],
          };
        }

        const snapshotPath = writeSnapshot({
          domain: domainName,
          writtenBy: `update_dns_record:pre-write:${operation}`,
          emailType: parsed.emailType,
          usingNamecheapDns: parsed.usingNamecheapDns,
          hosts: currentRecords,
          rawResponse: existingRaw,
        });

        // Multi-value types (MX, TXT, CAA, NS) can share a hostName+type tuple.
        // recordMatches treats `address` as required for those types on upsert,
        // so a second TXT at the same hostName appends rather than clobbering.
        // When address is omitted on a delete, match all records of the type at that hostName.
        const matches = (h: HostRecord) => recordMatches(h, record);

        let updatedRecords: HostRecord[];
        if (operation === 'delete') {
          updatedRecords = currentRecords.filter(h => !matches(h));
          // Delete on a missing record is a no-op: return cleanly without a
          // write round-trip (saves an API call and avoids triggering the
          // post-write verification path for an empty diff).
          if (updatedRecords.length === currentRecords.length) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  operation: 'delete',
                  domain: domainName,
                  record: { hostName: record.hostName, type: record.recordType, address: record.address },
                  result: 'no-op',
                  reason: 'no matching record found',
                  currentRecordCount: currentRecords.length,
                  snapshotPath,
                }, null, 2),
              }],
            };
          }
        } else {
          const newRecord: HostRecord = {
            hostName: record.hostName,
            recordType: record.recordType as RecordType,
            address: record.address!,
            mxPref: record.mxPref,
            ttl: record.ttl ?? 1800,
          };
          const idx = currentRecords.findIndex(h => matches(h));
          if (idx >= 0) {
            updatedRecords = [...currentRecords];
            updatedRecords[idx] = newRecord;
          } else {
            updatedRecords = [...currentRecords, newRecord];
          }
        }

        // Sanity check: write must not lose records we didn't intend to delete.
        const expectedDelta = operation === 'delete'
          ? Math.max(0, currentRecords.length - updatedRecords.length) * -1
          : updatedRecords.length - currentRecords.length;
        const actualDelta = updatedRecords.length - currentRecords.length;
        if (actualDelta !== expectedDelta) {
          return {
            isError: true,
            structuredContent: {
              errorCode: 'MERGE_SANITY_FAILED',
              currentCount: currentRecords.length,
              updatedCount: updatedRecords.length,
              expectedDelta,
              actualDelta,
              snapshotPath,
            },
            content: [{
              type: 'text',
              text:
                `Internal merge check failed: expected delta ${expectedDelta} but got ${actualDelta}. ` +
                `Refusing to write. Snapshot preserved at ${snapshotPath ?? '(snapshot write failed)'}.`,
            }],
          };
        }

        const hostParams = client.flattenHostRecords(updatedRecords);
        const writeParams: Record<string, string> = { SLD: sld, TLD: tld, ...hostParams };
        if (parsed.emailType) writeParams['EmailType'] = parsed.emailType;
        await client.execute('namecheap.domains.dns.setHosts', writeParams, 'POST');

        // Post-write verification: re-read the zone and compare.
        const postWriteRaw = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const postWrite = parseHostsWithDebug(postWriteRaw, client);
        writeSnapshot({
          domain: domainName,
          writtenBy: `update_dns_record:post-write:${operation}`,
          emailType: postWrite.emailType,
          usingNamecheapDns: postWrite.usingNamecheapDns,
          hosts: postWrite.hosts,
          rawResponse: postWriteRaw,
        });

        const countsMatch = postWrite.hosts.length === updatedRecords.length;
        const warning = !countsMatch
          ? ` WARNING: post-write count ${postWrite.hosts.length} does not match expected ${updatedRecords.length}. Pre-write snapshot at ${snapshotPath ?? '(unavailable)'}.`
          : '';

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              operation,
              domain: domainName,
              record: { hostName: record.hostName, type: record.recordType },
              previousRecordCount: currentRecords.length,
              expectedRecordCount: updatedRecords.length,
              actualPostWriteRecordCount: postWrite.hosts.length,
              countsMatch,
              snapshotPath,
              warning: warning || undefined,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'get_email_forwarding',
    {
      description: 'Get all email forwarding rules for a domain.',
      inputSchema: { domainName: z.string().describe('The domain name, e.g. "example.com"') },
    },
    async ({ domainName }) => {
      try {
        const result = await requireClient(getClient).execute('namecheap.domains.dns.getEmailForwarding', { DomainName: domainName });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'set_email_forwarding',
    {
      description:
        'DESTRUCTIVE: Replaces ALL email forwarding rules for a domain. Any rules not included will be deleted. ' +
        'Gated: requires confirmReplaceAll:true. Call get_email_forwarding first if you want to preserve existing rules.',
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        forwards: z.array(z.object({
          mailbox: z.string().describe('The local part before @, e.g. "info" for info@example.com'),
          forwardTo: z.string().describe('Full destination email address'),
        })).describe('List of forwarding rules'),
        confirmReplaceAll: z.literal(true).describe(
          'Must be exactly `true` to acknowledge this call replaces all forwarding rules.'
        ),
      },
    },
    async ({ domainName, forwards }) => {
      try {
        const params: Record<string, string | number> = { DomainName: domainName };
        forwards.forEach((fwd, i) => {
          const n = i + 1;
          params[`MailBox${n}`] = fwd.mailbox;
          params[`ForwardTo${n}`] = fwd.forwardTo;
        });
        const result = await requireClient(getClient).execute('namecheap.domains.dns.setEmailForwarding', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'set_dns_default',
    {
      description: "Switch a domain back to using Namecheap's default DNS servers. Use this to revert from custom nameservers.",
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        confirmMutation: z.literal(true).describe('Must be true to approve this nameserver mutation.'),
      },
    },
    async ({ domainName }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);
        const result = await client.execute('namecheap.domains.dns.setDefault', { SLD: sld, TLD: tld });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'set_dns_custom',
    {
      description: 'Set custom nameservers for a domain (e.g. to delegate DNS to Cloudflare, Route53, etc.).',
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        nameservers: z.array(z.string()).min(2).max(12)
          .describe('List of nameserver hostnames, e.g. ["ns1.cloudflare.com", "ns2.cloudflare.com"]'),
        confirmMutation: z.literal(true).describe('Must be true to approve this nameserver mutation.'),
      },
    },
    async ({ domainName, nameservers }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);
        const result = await client.execute('namecheap.domains.dns.setCustom', {
          SLD: sld,
          TLD: tld,
          Nameservers: nameservers.join(','),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'list_dns_snapshots',
    {
      description:
        'List local DNS zone snapshots for a domain. Snapshots are written automatically before every write (and on every get_dns_hosts read) to ~/.config/namecheap-mcp/snapshots/. Use this to find a snapshot to restore with restore_dns_snapshot.',
      inputSchema: { domainName: z.string().describe('The domain name, e.g. "example.com"') },
    },
    async ({ domainName }) => {
      try {
        const infos = listSnapshots(domainName);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              domain: domainName,
              snapshotsDir: SNAPSHOTS_DIR,
              count: infos.length,
              snapshots: infos,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'restore_dns_snapshot',
    {
      description:
        'Restore a DNS zone from a local snapshot file. DESTRUCTIVE: replaces the entire current zone with the snapshotted record set. ' +
        'Requires confirmReplaceAll:true. Writes a pre-restore snapshot first so the current state is also preserved.',
      inputSchema: {
        domainName: z.string().describe('The domain name, e.g. "example.com"'),
        snapshotPath: z.string().describe('Absolute path to the snapshot .json file (from list_dns_snapshots).'),
        confirmReplaceAll: z.literal(true).describe('Must be true. This replaces the entire current zone.'),
      },
    },
    async ({ domainName, snapshotPath }) => {
      try {
        const client = requireClient(getClient);
        const { sld, tld } = client.splitDomain(domainName);

        let snapshot;
        try {
          snapshot = readSnapshot(snapshotPath);
        } catch (readErr) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          return {
            isError: true,
            structuredContent: { errorCode: 'SNAPSHOT_READ_FAILED', snapshotPath, reason: msg },
            content: [{
              type: 'text',
              text:
                `Could not read snapshot at ${snapshotPath}: ${msg}. ` +
                `The file may be missing, truncated, or from a different snapshot schema version. ` +
                `Use list_dns_snapshots to find a valid snapshot.`,
            }],
          };
        }
        if (snapshot.domain !== domainName) {
          return {
            isError: true,
            structuredContent: { errorCode: 'SNAPSHOT_DOMAIN_MISMATCH', snapshotDomain: snapshot.domain, requestedDomain: domainName },
            content: [{ type: 'text', text: `Snapshot is for domain "${snapshot.domain}" but you requested restore to "${domainName}". Refusing.` }],
          };
        }

        // Snapshot current state first so restore is itself reversible.
        const currentRaw = await client.execute('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
        const currentParsed = parseHostsWithDebug(currentRaw, client);
        const preRestoreSnapshot = writeSnapshot({
          domain: domainName,
          writtenBy: 'restore_dns_snapshot:pre-restore',
          emailType: currentParsed.emailType,
          usingNamecheapDns: currentParsed.usingNamecheapDns,
          hosts: currentParsed.hosts,
          rawResponse: currentRaw,
        });

        const hostParams = client.flattenHostRecords(snapshot.hosts);
        const writeParams: Record<string, string> = { SLD: sld, TLD: tld, ...hostParams };
        if (snapshot.emailType) writeParams['EmailType'] = snapshot.emailType;
        await client.execute('namecheap.domains.dns.setHosts', writeParams, 'POST');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              domain: domainName,
              restoredFrom: snapshotPath,
              restoredRecordCount: snapshot.hosts.length,
              previousRecordCount: currentParsed.hosts.length,
              preRestoreSnapshot,
            }, null, 2),
          }],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );
}
