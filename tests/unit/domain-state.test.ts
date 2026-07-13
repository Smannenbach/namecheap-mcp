import { describe, expect, it } from 'vitest';
import {
  findExactDomainListEntry,
  findExactPrivacySubscription,
  mergeDomainState,
  parsePrivacyFromInfoResult,
  parseTriStateBoolean,
} from '../../src/domain-state.js';

const info = (overrides: Record<string, unknown> = {}) => ({
  DomainGetInfoResult: {
    '@_DomainName': 'example.com',
    '@_Status': 'Ok',
    '@_ID': 'info-id',
    DomainDetails: { CreatedDate: '01/01/2020', ExpiredDate: '01/01/2030' },
    DnsDetails: { '@_ProviderType': 'CUSTOM', Nameserver: ['ns1.example.net', 'ns2.example.net'] },
    ...overrides,
  },
});

const registrarLock = (value?: string) => ({
  DomainGetRegistrarLockResult: {
    '@_Domain': 'example.com',
    ...(value === undefined ? {} : { '@_RegistrarLockStatus': value }),
  },
});

describe('domain state parsing', () => {
  it('uses the dedicated registrar-lock endpoint when the list lock conflicts', () => {
    const state = mergeDomainState(
      'example.com',
      {
        DomainGetListResult: {
          Domain: {
            '@_Name': 'example.com',
            '@_ID': 'list-id',
            '@_IsLocked': 'false',
            '@_AutoRenew': 'true',
            '@_WhoisGuard': 'ENABLED',
          },
        },
      },
      info({ Whoisguard: { '@_Enabled': 'False', ID: '77', ExpiredDate: '01/01/2030' } }),
      registrarLock('true'),
    );

    expect(state.registrarLocked).toBe(true);
    expect(state.listChangeLocked).toBe(false);
    expect(state.autoRenew).toBe(true);
    expect(state.domainPrivacy.enabled).toBe(true);
    expect(state.domainPrivacy.statusSource).toBe('namecheap.domains.getList');
    expect(state.domainPrivacy.id).toBe('77');
  });

  it('requires an exact domain match instead of accepting a substring result', () => {
    const result = {
      DomainGetListResult: {
        Domain: [
          { '@_Name': 'notexample.com', '@_AutoRenew': 'false' },
          { '@_Name': 'EXAMPLE.COM.', '@_AutoRenew': 'true' },
        ],
      },
    };

    expect(findExactDomainListEntry(result, 'example.com')?.['@_AutoRenew']).toBe('true');
    expect(findExactDomainListEntry(result, 'ample.com')).toBeNull();
  });

  it('returns null for absent booleans rather than silently converting them to false', () => {
    const state = mergeDomainState(
      'example.com',
      { DomainGetListResult: {} },
      info(),
      registrarLock(),
    );

    expect(state.autoRenew).toBeNull();
    expect(state.expired).toBeNull();
    expect(state.listChangeLocked).toBeNull();
    expect(state.registrarLocked).toBeNull();
    expect(state.domainPrivacy.enabled).toBeNull();
    expect(state.sources.exactDomainListMatch).toBe(false);
  });

  it('parses documented getInfo child elements and legacy attribute variants', () => {
    expect(parsePrivacyFromInfoResult(
      info({ Whoisguard: { '@_Enabled': 'True', ID: '3655801', ExpiredDate: '01/26/2030' } }),
      'example.com',
    )).toMatchObject({ enabled: true, id: '3655801', expires: '01/26/2030' });

    expect(parsePrivacyFromInfoResult(
      info({ WhoisGuard: { '@_Enabled': 'DISABLED', '@_ID': '42', '@_ExpiredDate': '02/01/2030' } }),
      'example.com',
    )).toMatchObject({ enabled: false, id: '42', expires: '02/01/2030' });
  });

  it('parses current domain-privacy list variants and matches the exact domain', () => {
    const result = {
      WhoisguardGetListResult: {
        Whoisguard: [
          { '@_ID': '1', '@_DomainName': 'notexample.com', '@_Status': 'enabled' },
          { '@_ID': '2', '@_DomainName': 'example.com', '@_Status': 'enabled', '@_Expires': '03/01/2030' },
        ],
      },
    };

    expect(findExactPrivacySubscription(result, 'example.com')).toEqual({
      id: '2',
      domain: 'example.com',
      status: 'enabled',
      enabled: true,
      created: null,
      expires: '03/01/2030',
    });
    expect(findExactPrivacySubscription(result, 'ample.com')).toBeNull();
  });

  it('recognizes supported boolean/status variants and leaves unknown values unknown', () => {
    expect(parseTriStateBoolean('ENABLED')).toBe(true);
    expect(parseTriStateBoolean('False')).toBe(false);
    expect(parseTriStateBoolean('NOTPRESENT')).toBe(false);
    expect(parseTriStateBoolean('unexpected')).toBeNull();
    expect(parseTriStateBoolean(undefined)).toBeNull();
  });
});
