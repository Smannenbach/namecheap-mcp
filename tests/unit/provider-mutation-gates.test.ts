import { describe, expect, it } from 'vitest';
import { registerDnsTools } from '../../src/tools/dns.js';
import { registerDomainTools } from '../../src/tools/domains.js';
import { registerSslTools } from '../../src/tools/ssl.js';
import { registerTransferTools } from '../../src/tools/transfers.js';

describe('provider mutation approval gates', () => {
  it('requires an explicit true literal for every provider mutation tool', () => {
    const configs = new Map<string, Record<string, unknown>>();
    const server = {
      registerTool(name: string, config: Record<string, unknown>) {
        configs.set(name, config);
      },
    };
    const getClient = () => null;
    registerDomainTools(server as never, getClient);
    registerDnsTools(server as never, getClient);
    registerSslTools(server as never, getClient);
    registerTransferTools(server as never, getClient);

    const gates: Record<string, 'confirmMutation' | 'confirmReplaceAll'> = {
      renew_domain: 'confirmMutation',
      set_whoisguard: 'confirmMutation',
      set_registrar_lock: 'confirmMutation',
      register_domain: 'confirmMutation',
      set_domain_contacts: 'confirmMutation',
      reactivate_domain: 'confirmMutation',
      renew_whoisguard: 'confirmMutation',
      set_dns_hosts: 'confirmReplaceAll',
      update_dns_record: 'confirmMutation',
      set_email_forwarding: 'confirmReplaceAll',
      set_dns_default: 'confirmMutation',
      set_dns_custom: 'confirmMutation',
      restore_dns_snapshot: 'confirmReplaceAll',
      create_ssl_cert: 'confirmMutation',
      activate_ssl: 'confirmMutation',
      reissue_ssl: 'confirmMutation',
      transfer_domain: 'confirmMutation',
    };

    for (const [toolName, gateName] of Object.entries(gates)) {
      const config = configs.get(toolName) as {
        inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
      } | undefined;
      expect(config, toolName).toBeDefined();
      const gate = config!.inputSchema[gateName];
      expect(gate, `${toolName}.${gateName}`).toBeDefined();
      expect(gate.safeParse(true).success, toolName).toBe(true);
      expect(gate.safeParse(false).success, toolName).toBe(false);
      expect(gate.safeParse(undefined).success, toolName).toBe(false);
    }
  });
});
