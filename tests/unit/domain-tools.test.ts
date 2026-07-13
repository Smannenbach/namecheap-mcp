import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDomainTools } from '../../src/tools/domains.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function setup() {
  const handlers = new Map<string, ToolHandler>();
  const configs = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: ToolHandler) {
      configs.set(name, config);
      handlers.set(name, handler);
    },
  };
  const execute = vi.fn();
  registerDomainTools(server as never, () => ({ execute }) as never);
  return { handlers, configs, execute };
}

function handler(map: Map<string, ToolHandler>, name: string): ToolHandler {
  const result = map.get(name);
  if (!result) throw new Error(`Missing handler ${name}`);
  return result;
}

function parsedText(result: Record<string, unknown>) {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('domain tools safety', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('combines getList, getInfo, and the dedicated registrar-lock endpoint', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainGetListResult: {
          Domain: [
            { '@_Name': 'notexample.com', '@_AutoRenew': 'false', '@_WhoisGuard': 'DISABLED' },
            { '@_Name': 'example.com', '@_AutoRenew': 'true', '@_WhoisGuard': 'ENABLED', '@_IsLocked': 'false' },
          ],
        },
      })
      .mockResolvedValueOnce({
        DomainGetInfoResult: {
          '@_DomainName': 'example.com',
          '@_Status': 'Ok',
          Whoisguard: { '@_Enabled': 'True', ID: '12' },
          DnsDetails: { '@_ProviderType': 'CUSTOM' },
        },
      })
      .mockResolvedValueOnce({
        DomainGetRegistrarLockResult: { '@_Domain': 'example.com', '@_RegistrarLockStatus': 'true' },
      });

    const result = await handler(handlers, 'get_domain_info')({ domainName: 'example.com' });
    const payload = parsedText(result);

    expect(execute.mock.calls.map(call => call[0])).toEqual([
      'namecheap.domains.getList',
      'namecheap.domains.getInfo',
      'namecheap.domains.getRegistrarLock',
    ]);
    expect(payload).toMatchObject({
      autoRenew: true,
      registrarLocked: true,
      listChangeLocked: false,
      locked: true,
      domainPrivacy: { enabled: true, id: '12' },
    });
  });

  it('continues paginated search results until it finds the exact domain', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainGetListResult: { Domain: { '@_Name': 'notexample.com', '@_AutoRenew': 'false' } },
        Paging: { TotalItems: '101' },
      })
      .mockResolvedValueOnce({
        DomainGetListResult: { Domain: { '@_Name': 'example.com', '@_AutoRenew': 'true', '@_WhoisGuard': 'ENABLED' } },
        Paging: { TotalItems: '101' },
      })
      .mockResolvedValueOnce({ DomainGetInfoResult: { '@_DomainName': 'example.com' } })
      .mockResolvedValueOnce({
        DomainGetRegistrarLockResult: { '@_Domain': 'example.com', '@_RegistrarLockStatus': 'true' },
      });

    const result = await handler(handlers, 'get_domain_info')({ domainName: 'example.com' });
    expect(execute.mock.calls[0][1]).toMatchObject({ Page: 1, PageSize: 100 });
    expect(execute.mock.calls[1][1]).toMatchObject({ Page: 2, PageSize: 100 });
    expect(parsedText(result)).toMatchObject({ autoRenew: true, registrarLocked: true });
  });

  it('makes zero provider calls for unsupported auto-renew changes', async () => {
    const { handlers, execute } = setup();
    const result = await handler(handlers, 'set_domain_autorenew')({
      domainName: 'example.com',
      autoRenew: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'UNSUPPORTED_API_COMMAND',
      providerCallsMade: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects registrar-lock acknowledgement failures without trusting requested state', async () => {
    const { handlers, execute } = setup();
    execute.mockResolvedValueOnce({
      DomainSetRegistrarLockResult: { '@_Domain': 'example.com', '@_IsSuccess': 'false' },
    });

    const result = await handler(handlers, 'set_registrar_lock')({
      domainName: 'example.com',
      locked: true,
      confirmMutation: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorCode: 'REGISTRAR_LOCK_NOT_ACKNOWLEDGED' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails when registrar-lock readback disagrees with the acknowledged mutation', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainSetRegistrarLockResult: { '@_Domain': 'example.com', '@_IsSuccess': 'true' },
      })
      .mockResolvedValueOnce({
        DomainGetRegistrarLockResult: { '@_Domain': 'example.com', '@_RegistrarLockStatus': 'false' },
      });

    const result = await handler(handlers, 'set_registrar_lock')({
      domainName: 'example.com',
      locked: true,
      confirmMutation: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'REGISTRAR_LOCK_READBACK_MISMATCH',
      readbackLocked: false,
    });
  });

  it('returns success only after dedicated registrar-lock readback matches', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainSetRegistrarLockResult: { '@_Domain': 'example.com', '@_IsSuccess': 'true' },
      })
      .mockResolvedValueOnce({
        DomainGetRegistrarLockResult: { '@_Domain': 'example.com', '@_RegistrarLockStatus': 'true' },
      });

    const result = await handler(handlers, 'set_registrar_lock')({
      domainName: 'example.com',
      locked: true,
      confirmMutation: true,
    });

    expect(result.isError).toBeUndefined();
    expect(parsedText(result)).toMatchObject({
      registrarLocked: true,
      acknowledgementVerified: true,
      readbackVerified: true,
    });
  });

  it('requires the documented forwarding email before any privacy-enable provider call', async () => {
    const { handlers, execute } = setup();
    const result = await handler(handlers, 'set_whoisguard')({
      domainName: 'example.com',
      enable: true,
      confirmMutation: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'PRIVACY_FORWARD_EMAIL_REQUIRED',
      providerCallsMade: 0,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('validates privacy acknowledgement and exact-domain readback', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainGetInfoResult: {
          '@_DomainName': 'example.com',
          Whoisguard: { '@_Enabled': 'False', ID: '77' },
        },
      })
      .mockResolvedValueOnce({
        WhoisguardEnableResult: { '@_DomainName': 'example.com', '@_IsSuccess': 'true' },
      })
      .mockResolvedValueOnce({
        DomainGetListResult: { Domain: { '@_Name': 'example.com', '@_WhoisGuard': 'ENABLED' } },
      });

    const result = await handler(handlers, 'set_whoisguard')({
      domainName: 'example.com',
      enable: true,
      forwardedToEmail: 'privacy@example.com',
      confirmMutation: true,
    });

    expect(result.isError).toBeUndefined();
    expect(execute.mock.calls[1]).toEqual([
      'namecheap.whoisguard.enable',
      { WhoisguardId: '77', ForwardedToEmail: 'privacy@example.com' },
    ]);
    expect(parsedText(result)).toMatchObject({
      domainPrivacyEnabled: true,
      acknowledgementVerified: true,
      readbackVerified: true,
    });
  });

  it('falls back to current domain-privacy getList parsing when getInfo has no ID', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainGetInfoResult: { '@_DomainName': 'example.com', Whoisguard: { '@_Enabled': 'True' } },
      })
      .mockResolvedValueOnce({
        WhoisguardGetListResult: {
          Whoisguard: { '@_ID': '88', '@_DomainName': 'example.com', '@_Status': 'enabled' },
        },
      })
      .mockResolvedValueOnce({
        WhoisguardDisableResult: { '@_DomainName': 'example.com', '@_IsSuccess': 'true' },
      })
      .mockResolvedValueOnce({
        DomainGetListResult: { Domain: { '@_Name': 'example.com', '@_WhoisGuard': 'DISABLED' } },
      });

    const result = await handler(handlers, 'set_whoisguard')({
      domainName: 'example.com',
      enable: false,
      confirmMutation: true,
    });

    expect(result.isError).toBeUndefined();
    expect(execute.mock.calls[2]).toEqual([
      'namecheap.whoisguard.disable',
      { WhoisguardId: '88' },
    ]);
  });

  it('fails privacy mutation when post-write readback does not match', async () => {
    const { handlers, execute } = setup();
    execute
      .mockResolvedValueOnce({
        DomainGetInfoResult: { '@_DomainName': 'example.com', Whoisguard: { '@_Enabled': 'False', ID: '77' } },
      })
      .mockResolvedValueOnce({
        WhoisguardEnableResult: { '@_DomainName': 'example.com', '@_IsSuccess': 'true' },
      })
      .mockResolvedValueOnce({
        DomainGetListResult: { Domain: { '@_Name': 'example.com', '@_WhoisGuard': 'DISABLED' } },
      });

    const result = await handler(handlers, 'set_whoisguard')({
      domainName: 'example.com',
      enable: true,
      forwardedToEmail: 'privacy@example.com',
      confirmMutation: true,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      errorCode: 'PRIVACY_READBACK_MISMATCH',
      readbackEnabled: false,
    });
  });

  it('requires an explicit confirmation literal for each active domain mutation', () => {
    const { configs } = setup();
    const mutationTools = [
      'renew_domain',
      'set_whoisguard',
      'set_registrar_lock',
      'register_domain',
      'set_domain_contacts',
      'reactivate_domain',
      'renew_whoisguard',
    ];

    for (const tool of mutationTools) {
      const config = configs.get(tool) as { inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }> };
      expect(config.inputSchema.confirmMutation.safeParse(true).success, tool).toBe(true);
      expect(config.inputSchema.confirmMutation.safeParse(false).success, tool).toBe(false);
      expect(config.inputSchema.confirmMutation.safeParse(undefined).success, tool).toBe(false);
    }
  });
});
