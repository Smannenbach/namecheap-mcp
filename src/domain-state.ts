export type RawRecord = Record<string, unknown>;

export interface DomainPrivacyState {
  enabled: boolean | null;
  status: string | null;
  id: string | null;
  expires: string | null;
  statusSource: 'namecheap.domains.getList' | 'namecheap.domains.getInfo' | null;
}

export interface DomainState {
  domain: string;
  status: string | null;
  id: string | null;
  owner: string | null;
  created: string | null;
  expires: string | null;
  expired: boolean | null;
  autoRenew: boolean | null;
  registrarLocked: boolean | null;
  listChangeLocked: boolean | null;
  domainPrivacy: DomainPrivacyState;
  dns: {
    type: string | null;
    nameservers: unknown[];
  };
  sources: {
    exactDomainListMatch: boolean;
    autoRenew: 'namecheap.domains.getList';
    domainPrivacyStatus: 'namecheap.domains.getList' | 'namecheap.domains.getInfo' | null;
    registrarLock: 'namecheap.domains.getRegistrarLock';
    listChangeLock: 'namecheap.domains.getList';
  };
}

export interface PrivacySubscription {
  id: string | null;
  domain: string;
  status: string | null;
  enabled: boolean | null;
  created: string | null;
  expires: string | null;
}

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RawRecord
    : null;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function normalizeDomain(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

export function parseTriStateBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'disabled', 'notpresent', 'not_present'].includes(normalized)) return false;
  return null;
}

function domainMatches(actual: unknown, expected: string): boolean {
  const actualText = text(actual);
  return actualText !== null && normalizeDomain(actualText) === normalizeDomain(expected);
}

export function findExactDomainListEntry(result: unknown, domainName: string): RawRecord | null {
  const root = asRecord(result);
  const envelope = asRecord(root?.['DomainGetListResult']);
  const entries = asList(envelope?.['Domain']);
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record && domainMatches(record['@_Name'], domainName)) return record;
  }
  return null;
}

export function parseDomainInfoResult(result: unknown, domainName: string): RawRecord {
  const root = asRecord(result);
  const info = asRecord(root?.['DomainGetInfoResult']);
  if (!info) {
    throw new Error('getInfo response missing DomainGetInfoResult.');
  }
  const responseDomain = info['@_DomainName'];
  if (responseDomain !== undefined && !domainMatches(responseDomain, domainName)) {
    throw new Error(`getInfo returned domain "${String(responseDomain)}" instead of "${domainName}".`);
  }
  return info;
}

export function parseRegistrarLockResult(result: unknown, domainName: string): boolean | null {
  const root = asRecord(result);
  const lock = asRecord(root?.['DomainGetRegistrarLockResult']);
  if (!lock) {
    throw new Error('getRegistrarLock response missing DomainGetRegistrarLockResult.');
  }
  const responseDomain = lock['@_Domain'];
  if (responseDomain !== undefined && !domainMatches(responseDomain, domainName)) {
    throw new Error(`getRegistrarLock returned domain "${String(responseDomain)}" instead of "${domainName}".`);
  }
  return parseTriStateBoolean(lock['@_RegistrarLockStatus']);
}

function privacyFromInfo(info: RawRecord): DomainPrivacyState {
  const privacy = asRecord(info['Whoisguard']) ?? asRecord(info['WhoisGuard']);
  if (!privacy) {
    return { enabled: null, status: null, id: null, expires: null, statusSource: null };
  }
  const status = text(privacy['@_Enabled'] ?? privacy['Enabled'] ?? privacy['@_Status'] ?? privacy['Status']);
  return {
    enabled: parseTriStateBoolean(status),
    status,
    id: text(privacy['ID'] ?? privacy['@_ID'] ?? privacy['WhoisguardId'] ?? privacy['@_WhoisguardId']),
    expires: text(privacy['ExpiredDate'] ?? privacy['@_ExpiredDate'] ?? privacy['Expires'] ?? privacy['@_Expires']),
    statusSource: status === null ? null : 'namecheap.domains.getInfo',
  };
}

export function mergeDomainState(
  domainName: string,
  listResult: unknown,
  infoResult: unknown,
  registrarLockResult: unknown,
): DomainState {
  const list = findExactDomainListEntry(listResult, domainName);
  const info = parseDomainInfoResult(infoResult, domainName);
  const details = asRecord(info['DomainDetails']);
  const dns = asRecord(info['DnsDetails']);
  const nameservers = asList(dns?.['Nameserver']);
  const infoPrivacy = privacyFromInfo(info);
  const listPrivacyStatus = text(list?.['@_WhoisGuard']);
  const privacyStatus = listPrivacyStatus ?? infoPrivacy.status;
  const privacyStatusSource = listPrivacyStatus !== null
    ? 'namecheap.domains.getList' as const
    : infoPrivacy.statusSource;

  return {
    domain: text(list?.['@_Name'] ?? info['@_DomainName']) ?? normalizeDomain(domainName),
    status: text(info['@_Status']),
    id: text(list?.['@_ID'] ?? info['@_ID']),
    owner: text(info['@_OwnerName']),
    created: text(list?.['@_Created'] ?? details?.['CreatedDate']),
    expires: text(list?.['@_Expires'] ?? details?.['ExpiredDate']),
    expired: parseTriStateBoolean(list?.['@_IsExpired'] ?? info['@_IsExpired']),
    autoRenew: parseTriStateBoolean(list?.['@_AutoRenew']),
    registrarLocked: parseRegistrarLockResult(registrarLockResult, domainName),
    listChangeLocked: parseTriStateBoolean(list?.['@_IsLocked']),
    domainPrivacy: {
      enabled: parseTriStateBoolean(privacyStatus),
      status: privacyStatus,
      id: infoPrivacy.id,
      expires: infoPrivacy.expires,
      statusSource: privacyStatusSource,
    },
    dns: {
      type: text(dns?.['@_ProviderType']),
      nameservers,
    },
    sources: {
      exactDomainListMatch: list !== null,
      autoRenew: 'namecheap.domains.getList',
      domainPrivacyStatus: privacyStatusSource,
      registrarLock: 'namecheap.domains.getRegistrarLock',
      listChangeLock: 'namecheap.domains.getList',
    },
  };
}

export function findExactPrivacySubscription(result: unknown, domainName: string): PrivacySubscription | null {
  const root = asRecord(result);
  const envelope = asRecord(root?.['WhoisguardGetListResult']) ?? asRecord(root?.['DomainprivacyGetListResult']);
  const entries = asList(envelope?.['Whoisguard'] ?? envelope?.['DomainPrivacy']);
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const responseDomain = record['@_DomainName'] ?? record['DomainName'];
    if (!domainMatches(responseDomain, domainName)) continue;
    const status = text(record['@_Status'] ?? record['Status'] ?? record['@_Enabled'] ?? record['Enabled']);
    return {
      id: text(record['@_ID'] ?? record['ID'] ?? record['@_WhoisguardId'] ?? record['WhoisguardId']),
      domain: text(responseDomain) ?? normalizeDomain(domainName),
      status,
      enabled: parseTriStateBoolean(status),
      created: text(record['@_Created'] ?? record['Created']),
      expires: text(record['@_Expires'] ?? record['Expires'] ?? record['@_ExpiredDate'] ?? record['ExpiredDate']),
    };
  }
  return null;
}

export function parseMutationAcknowledgement(
  result: unknown,
  envelopeName: string,
  domainName: string,
): { acknowledged: boolean; domainMatches: boolean; responseDomain: string | null } {
  const root = asRecord(result);
  const envelope = asRecord(root?.[envelopeName]);
  const responseDomain = text(envelope?.['@_Domain'] ?? envelope?.['@_DomainName']);
  return {
    acknowledged: parseTriStateBoolean(envelope?.['@_IsSuccess']) === true,
    domainMatches: responseDomain !== null && domainMatches(responseDomain, domainName),
    responseDomain,
  };
}

export function parseWhoisguardRenewAcknowledgement(
  result: unknown,
  expectedId: string,
): { acknowledged: boolean; idMatches: boolean; responseId: string | null } {
  const root = asRecord(result);
  const envelope = asRecord(root?.['WhoisguardRenewResult']);
  const responseId = text(envelope?.['@_WhoisguardId'] ?? envelope?.['@_WhoisGuardId'] ?? envelope?.['@_ID']);
  return {
    acknowledged: parseTriStateBoolean(envelope?.['@_Renew']) === true,
    idMatches: responseId !== null && responseId === expectedId,
    responseId,
  };
}

export function parsePrivacyFromInfoResult(result: unknown, domainName: string): DomainPrivacyState {
  return privacyFromInfo(parseDomainInfoResult(result, domainName));
}
