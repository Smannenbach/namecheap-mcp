function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function asList(value) {
    if (Array.isArray(value))
        return value;
    return value === null || value === undefined ? [] : [value];
}
function text(value) {
    if (value === null || value === undefined || value === '')
        return null;
    return String(value);
}
export function normalizeDomain(value) {
    return value.trim().replace(/\.$/, '').toLowerCase();
}
export function parseTriStateBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'enabled'].includes(normalized))
        return true;
    if (['false', '0', 'no', 'disabled', 'notpresent', 'not_present'].includes(normalized))
        return false;
    return null;
}
function domainMatches(actual, expected) {
    const actualText = text(actual);
    return actualText !== null && normalizeDomain(actualText) === normalizeDomain(expected);
}
export function findExactDomainListEntry(result, domainName) {
    const root = asRecord(result);
    const envelope = asRecord(root?.['DomainGetListResult']);
    const entries = asList(envelope?.['Domain']);
    for (const entry of entries) {
        const record = asRecord(entry);
        if (record && domainMatches(record['@_Name'], domainName))
            return record;
    }
    return null;
}
export function parseDomainInfoResult(result, domainName) {
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
export function parseRegistrarLockResult(result, domainName) {
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
function privacyFromInfo(info) {
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
export function mergeDomainState(domainName, listResult, infoResult, registrarLockResult) {
    const list = findExactDomainListEntry(listResult, domainName);
    const info = parseDomainInfoResult(infoResult, domainName);
    const details = asRecord(info['DomainDetails']);
    const dns = asRecord(info['DnsDetails']);
    const nameservers = asList(dns?.['Nameserver']);
    const infoPrivacy = privacyFromInfo(info);
    const listPrivacyStatus = text(list?.['@_WhoisGuard']);
    const privacyStatus = listPrivacyStatus ?? infoPrivacy.status;
    const privacyStatusSource = listPrivacyStatus !== null
        ? 'namecheap.domains.getList'
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
export function findExactPrivacySubscription(result, domainName) {
    const root = asRecord(result);
    const envelope = asRecord(root?.['WhoisguardGetListResult']) ?? asRecord(root?.['DomainprivacyGetListResult']);
    const entries = asList(envelope?.['Whoisguard'] ?? envelope?.['DomainPrivacy']);
    for (const entry of entries) {
        const record = asRecord(entry);
        if (!record)
            continue;
        const responseDomain = record['@_DomainName'] ?? record['DomainName'];
        if (!domainMatches(responseDomain, domainName))
            continue;
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
export function parseMutationAcknowledgement(result, envelopeName, domainName) {
    const root = asRecord(result);
    const envelope = asRecord(root?.[envelopeName]);
    const responseDomain = text(envelope?.['@_Domain'] ?? envelope?.['@_DomainName']);
    return {
        acknowledged: parseTriStateBoolean(envelope?.['@_IsSuccess']) === true,
        domainMatches: responseDomain !== null && domainMatches(responseDomain, domainName),
        responseDomain,
    };
}
export function parseWhoisguardRenewAcknowledgement(result, expectedId) {
    const root = asRecord(result);
    const envelope = asRecord(root?.['WhoisguardRenewResult']);
    const responseId = text(envelope?.['@_WhoisguardId'] ?? envelope?.['@_WhoisGuardId'] ?? envelope?.['@_ID']);
    return {
        acknowledged: parseTriStateBoolean(envelope?.['@_Renew']) === true,
        idMatches: responseId !== null && responseId === expectedId,
        responseId,
    };
}
export function parsePrivacyFromInfoResult(result, domainName) {
    return privacyFromInfo(parseDomainInfoResult(result, domainName));
}
//# sourceMappingURL=domain-state.js.map