import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const expectSecure = args.includes('--expect-secure');
const domainName = args.find(arg => !arg.startsWith('--'));
if (!domainName) {
  throw new Error('Usage: npm run smoke:readonly -- <domain> [--expect-secure]');
}

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env,
});
const client = new Client({ name: 'namecheap-mcp-readonly-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === 'get_domain_info')) {
    throw new Error('Authenticated tool suite did not expose get_domain_info.');
  }

  const result = await client.callTool({
    name: 'get_domain_info',
    arguments: { domainName },
  });
  if (result.isError) {
    throw new Error('get_domain_info returned an error during read-only smoke verification.');
  }
  const textContent = result.content.find(item => item.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('get_domain_info returned no text payload.');
  }
  const payload = JSON.parse(textContent.text);
  if (payload.sources?.exactDomainListMatch !== true) {
    throw new Error('Exact-domain getList matching was not confirmed.');
  }
  if (payload.sources?.registrarLock !== 'namecheap.domains.getRegistrarLock') {
    throw new Error('Registrar lock was not sourced from the dedicated endpoint.');
  }
  if (expectSecure && (
    payload.registrarLocked !== true ||
    payload.autoRenew !== true ||
    payload.domainPrivacy?.enabled !== true
  )) {
    throw new Error('Secure registrar expectations were not met.');
  }

  process.stdout.write(JSON.stringify({
    domain: payload.domain,
    exactDomainListMatch: payload.sources.exactDomainListMatch,
    registrarLocked: payload.registrarLocked,
    registrarLockSource: payload.sources.registrarLock,
    autoRenew: payload.autoRenew,
    autoRenewSource: payload.sources.autoRenew,
    domainPrivacyEnabled: payload.domainPrivacy?.enabled ?? null,
    domainPrivacySource: payload.sources.domainPrivacyStatus,
    listChangeLocked: payload.listChangeLocked,
    toolsAvailable: tools.tools.length,
  }, null, 2) + '\n');
} finally {
  await client.close();
}
