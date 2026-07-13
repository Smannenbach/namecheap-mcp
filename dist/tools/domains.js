import { z } from 'zod';
import { requireClient } from '../config.js';
import { toErrorResult } from '../errors.js';
import { findExactDomainListEntry, findExactPrivacySubscription, mergeDomainState, parseMutationAcknowledgement, parsePrivacyFromInfoResult, parseRegistrarLockResult, parseTriStateBoolean, parseWhoisguardRenewAcknowledgement, } from '../domain-state.js';
function failClosed(errorCode, message, details = {}) {
    return {
        isError: true,
        structuredContent: { errorCode, ...details },
        content: [{ type: 'text', text: message }],
    };
}
function pageStats(result, envelopeName, itemName) {
    const root = result;
    const envelope = root?.[envelopeName];
    const rawItems = envelope?.[itemName];
    const itemCount = Array.isArray(rawItems) ? rawItems.length : rawItems ? 1 : 0;
    const paging = root?.['Paging'];
    const parsedTotal = Number.parseInt(String(paging?.['TotalItems'] ?? ''), 10);
    return {
        itemCount,
        totalItems: Number.isFinite(parsedTotal) ? parsedTotal : null,
    };
}
async function readExactDomainListEntry(client, domainName) {
    const pageSize = 100;
    let lastResult = { DomainGetListResult: {} };
    for (let page = 1; page <= 1000; page += 1) {
        const result = await client.execute('namecheap.domains.getList', {
            SearchTerm: domainName,
            Page: page,
            PageSize: pageSize,
        });
        lastResult = result;
        const entry = findExactDomainListEntry(result, domainName);
        if (entry)
            return { result, entry };
        const stats = pageStats(result, 'DomainGetListResult', 'Domain');
        const exhausted = stats.totalItems !== null
            ? page * pageSize >= stats.totalItems
            : stats.itemCount < pageSize;
        if (exhausted)
            break;
    }
    return { result: lastResult, entry: null };
}
async function readExactPrivacySubscription(client, domainName) {
    const pageSize = 100;
    for (let page = 1; page <= 1000; page += 1) {
        const subscriptions = await client.execute('namecheap.whoisguard.getList', {
            ListType: 'ALL',
            Page: page,
            PageSize: pageSize,
        });
        const exactSubscription = findExactPrivacySubscription(subscriptions, domainName);
        if (exactSubscription)
            return exactSubscription;
        const stats = pageStats(subscriptions, 'WhoisguardGetListResult', 'Whoisguard');
        const exhausted = stats.totalItems !== null
            ? page * pageSize >= stats.totalItems
            : stats.itemCount < pageSize;
        if (exhausted)
            break;
    }
    return null;
}
async function resolvePrivacySubscription(client, domainName) {
    const infoResult = await client.execute('namecheap.domains.getInfo', { DomainName: domainName });
    const infoPrivacy = parsePrivacyFromInfoResult(infoResult, domainName);
    if (infoPrivacy.id) {
        return { id: infoPrivacy.id, status: infoPrivacy.status, enabled: infoPrivacy.enabled, source: 'namecheap.domains.getInfo' };
    }
    const exactSubscription = await readExactPrivacySubscription(client, domainName);
    return exactSubscription
        ? { ...exactSubscription, source: 'namecheap.whoisguard.getList' }
        : null;
}
export function registerDomainTools(server, getClient) {
    server.registerTool('check_domains', {
        description: 'Check availability of one or more domains. Pass a comma-separated list like "example.com,example.net". Returns available/unavailable status per domain.',
        inputSchema: { domains: z.string().describe('Comma-separated list of domain names to check, e.g. "example.com,example.net"') },
    }, async ({ domains }) => {
        try {
            const result = await requireClient(getClient).execute('namecheap.domains.check', { DomainList: domains });
            const raw = result?.['DomainCheckResult'];
            const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
            const clean = list.map(d => {
                const isPremium = d['@_IsPremiumName'] === 'true';
                const entry = {
                    domain: d['@_Domain'],
                    available: d['@_Available'] === 'true',
                    isPremium,
                };
                if (isPremium)
                    entry['premiumPrice'] = parseFloat(d['@_PremiumRegistrationPrice'] ?? '0');
                return entry;
            });
            return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('list_domains', {
        description: 'List all domains in your Namecheap account. Supports pagination and search filtering. Call with increasing page values until hasNextPage is false to retrieve all domains.',
        inputSchema: {
            page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
            pageSize: z.number().int().min(1).max(100).optional().describe('Results per page, max 100 (default: 20)'),
            searchTerm: z.string().optional().describe('Filter domains by name substring'),
            listType: z.enum(['ALL', 'EXPIRING', 'EXPIRED']).optional().describe('Filter by domain status (default: ALL)'),
        },
    }, async ({ page, pageSize, searchTerm, listType }) => {
        try {
            const client = requireClient(getClient);
            const currentPage = page ?? 1;
            const currentPageSize = pageSize ?? 20;
            const params = {
                Page: currentPage,
                PageSize: currentPageSize,
            };
            if (searchTerm)
                params['SearchTerm'] = searchTerm;
            if (listType)
                params['ListType'] = listType;
            const result = await client.execute('namecheap.domains.getList', params);
            const r = result;
            const raw = r?.['DomainGetListResult'];
            const paging = r?.['Paging'];
            const domainList = raw?.['Domain'];
            const list = Array.isArray(domainList) ? domainList : domainList ? [domainList] : [];
            const domainsMapped = list.map(d => ({
                id: d['@_ID'],
                name: d['@_Name'],
                created: d['@_Created'],
                expires: d['@_Expires'],
                expired: parseTriStateBoolean(d['@_IsExpired']),
                listChangeLocked: parseTriStateBoolean(d['@_IsLocked']),
                registrarLocked: null,
                registrarLockNote: 'Not queried by list_domains. Use get_domain_info for the authoritative transfer-lock status.',
                autoRenew: parseTriStateBoolean(d['@_AutoRenew']),
                domainPrivacyStatus: d['@_WhoisGuard'] ?? null,
                domainPrivacyEnabled: parseTriStateBoolean(d['@_WhoisGuard']),
                usingNamecheapDns: parseTriStateBoolean(d['@_IsOurDNS']),
            }));
            const totalItems = parseInt(paging?.['TotalItems'] ?? '0', 10);
            const totalPages = Math.ceil(totalItems / currentPageSize);
            const clean = {
                domains: domainsMapped,
                pagination: {
                    page: currentPage,
                    pageSize: currentPageSize,
                    totalItems,
                    totalPages,
                    hasNextPage: currentPage < totalPages,
                },
            };
            return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('get_domain_info', {
        description: 'Get full details for a single domain: expiry date, auto-renew status, whois privacy, registrar lock, DNS settings.',
        inputSchema: { domainName: z.string().describe('The domain name, e.g. "example.com"') },
    }, async ({ domainName }) => {
        try {
            const client = requireClient(getClient);
            const { result: listResult } = await readExactDomainListEntry(client, domainName);
            const infoResult = await client.execute('namecheap.domains.getInfo', { DomainName: domainName });
            const registrarLockResult = await client.execute('namecheap.domains.getRegistrarLock', { DomainName: domainName });
            const state = mergeDomainState(domainName, listResult, infoResult, registrarLockResult);
            const clean = {
                ...state,
                locked: state.registrarLocked,
                whoisGuard: state.domainPrivacy,
                compatibility: {
                    locked: 'Compatibility alias for registrarLocked; sourced only from namecheap.domains.getRegistrarLock.',
                    whoisGuard: 'Compatibility alias for domainPrivacy.',
                },
            };
            return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('renew_domain', {
        description: 'Renew a domain for a specified number of years. Returns the new expiry date and transaction details.',
        inputSchema: {
            domainName: z.string().describe('The domain name to renew, e.g. "example.com"'),
            years: z.number().int().min(1).max(10).describe('Number of years to renew (1–10)'),
            confirmMutation: z.literal(true).describe('Must be true to approve this billable registrar mutation.'),
        },
    }, async ({ domainName, years }) => {
        try {
            const result = await requireClient(getClient).execute('namecheap.domains.renew', {
                DomainName: domainName,
                Years: years,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('get_tld_list', {
        description: 'Get supported TLDs available through Namecheap. Returns name, category, and registrability. ' +
            'Use `search` to filter by name substring and `registerable` to show only API-registerable TLDs.',
        inputSchema: {
            search: z.string().optional().describe('Filter TLDs by name substring, e.g. "ai" returns .ai, .cloudai, etc. (case-insensitive)'),
            registerable: z.boolean().optional().describe('When true, only return TLDs registerable via the API'),
        },
    }, async ({ search, registerable }) => {
        try {
            const result = await requireClient(getClient).execute('namecheap.domains.getTldList', {});
            const tldList = result?.['Tlds']?.['Tld'];
            if (!Array.isArray(tldList)) {
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }
            let filtered = tldList;
            if (search) {
                const lower = search.toLowerCase();
                filtered = filtered.filter(t => String(t['@_Name'] ?? '').toLowerCase().includes(lower));
            }
            if (registerable) {
                filtered = filtered.filter(t => t['@_IsApiRegisterable'] === 'true');
            }
            const slim = filtered.map(t => ({
                name: t['@_Name'],
                subCategory: t['@_SubCategory'],
                registerable: t['@_IsApiRegisterable'],
                renewable: t['@_IsApiRenewable'],
                transferable: t['@_IsApiTransferable'],
            }));
            return { content: [{ type: 'text', text: JSON.stringify(slim, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('set_domain_autorenew', {
        description: 'Compatibility-only tool. Namecheap does not publish a domains API command for changing auto-renew. ' +
            'This tool always fails closed and makes zero provider calls; use the authenticated Namecheap account UI.',
        inputSchema: {
            domainName: z.string().describe('The domain name, e.g. "example.com"'),
            autoRenew: z.boolean().describe('true to enable auto-renewal, false to disable'),
        },
    }, async ({ domainName, autoRenew }) => {
        return failClosed('UNSUPPORTED_API_COMMAND', 'Namecheap does not publish an API command for changing domain auto-renew. No provider call was made. Use the authenticated Namecheap account UI and verify the exact domain afterward.', {
            domain: domainName,
            requestedAutoRenew: autoRenew,
            providerCallsMade: 0,
            documentation: 'https://www.namecheap.com/support/api/methods/domains/',
        });
    });
    server.registerTool('set_whoisguard', {
        description: 'Enable or disable domain privacy. Requires explicit mutation approval, validates the provider acknowledgement, ' +
            'and verifies the exact domain state through namecheap.domains.getList after the write.',
        inputSchema: {
            domainName: z.string().describe('The domain name, e.g. "example.com"'),
            enable: z.boolean().describe('true to enable WHOIS guard, false to disable'),
            forwardedToEmail: z.string().email().optional().describe('Required by Namecheap when enable=true. Domain-privacy email is forwarded to this address.'),
            confirmMutation: z.literal(true).describe('Must be true to approve this registrar mutation.'),
        },
    }, async ({ domainName, enable, forwardedToEmail }) => {
        try {
            if (enable && !forwardedToEmail) {
                return failClosed('PRIVACY_FORWARD_EMAIL_REQUIRED', 'forwardedToEmail is required when enabling domain privacy. No provider call was made.', { domain: domainName, providerCallsMade: 0 });
            }
            const client = requireClient(getClient);
            const subscription = await resolvePrivacySubscription(client, domainName);
            if (!subscription?.id) {
                return failClosed('PRIVACY_SUBSCRIPTION_NOT_FOUND', `No exact domain-privacy subscription ID was found for ${domainName}; refusing to mutate.`, { domain: domainName });
            }
            const command = enable ? 'namecheap.whoisguard.enable' : 'namecheap.whoisguard.disable';
            const params = { WhoisguardId: subscription.id };
            if (enable)
                params['ForwardedToEmail'] = forwardedToEmail;
            const mutationResult = await client.execute(command, params);
            const envelopeName = enable ? 'WhoisguardEnableResult' : 'WhoisguardDisableResult';
            const acknowledgement = parseMutationAcknowledgement(mutationResult, envelopeName, domainName);
            if (!acknowledgement.acknowledged || !acknowledgement.domainMatches) {
                return failClosed('PRIVACY_MUTATION_NOT_ACKNOWLEDGED', 'Namecheap did not return an exact-domain successful acknowledgement; the requested privacy state is unproven.', { domain: domainName, requestedEnabled: enable, acknowledgement });
            }
            const postWrite = await readExactDomainListEntry(client, domainName);
            const readbackStatus = postWrite.entry?.['@_WhoisGuard'];
            const readbackEnabled = parseTriStateBoolean(readbackStatus);
            if (readbackEnabled !== enable) {
                return failClosed('PRIVACY_READBACK_MISMATCH', `Namecheap acknowledged the privacy mutation, but exact-domain readback did not confirm enabled=${enable}.`, {
                    domain: domainName,
                    requestedEnabled: enable,
                    readbackEnabled,
                    readbackStatus: readbackStatus ?? null,
                });
            }
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            domain: domainName,
                            domainPrivacyEnabled: readbackEnabled,
                            domainPrivacyStatus: readbackStatus,
                            acknowledgementVerified: true,
                            readbackVerified: true,
                        }, null, 2),
                    }],
            };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('set_registrar_lock', {
        description: 'Lock or unlock the registrar lock (transfer lock) for a domain. A locked domain cannot be transferred to another registrar.',
        inputSchema: {
            domainName: z.string().describe('The domain name, e.g. "example.com"'),
            locked: z.boolean().describe('true to lock the domain, false to unlock'),
            confirmMutation: z.literal(true).describe('Must be true to approve this registrar mutation.'),
        },
    }, async ({ domainName, locked }) => {
        try {
            const client = requireClient(getClient);
            const mutationResult = await client.execute('namecheap.domains.setRegistrarLock', {
                DomainName: domainName,
                LockAction: locked ? 'LOCK' : 'UNLOCK',
            });
            const acknowledgement = parseMutationAcknowledgement(mutationResult, 'DomainSetRegistrarLockResult', domainName);
            if (!acknowledgement.acknowledged || !acknowledgement.domainMatches) {
                return failClosed('REGISTRAR_LOCK_NOT_ACKNOWLEDGED', 'Namecheap did not return an exact-domain successful registrar-lock acknowledgement.', { domain: domainName, requestedLocked: locked, acknowledgement });
            }
            const readbackResult = await client.execute('namecheap.domains.getRegistrarLock', { DomainName: domainName });
            const readbackLocked = parseRegistrarLockResult(readbackResult, domainName);
            if (readbackLocked !== locked) {
                return failClosed('REGISTRAR_LOCK_READBACK_MISMATCH', `Namecheap acknowledged the registrar-lock mutation, but dedicated readback did not confirm locked=${locked}.`, { domain: domainName, requestedLocked: locked, readbackLocked });
            }
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            domain: domainName,
                            registrarLocked: readbackLocked,
                            acknowledgementVerified: true,
                            readbackVerified: true,
                            source: 'namecheap.domains.getRegistrarLock',
                        }, null, 2),
                    }],
            };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('register_domain', {
        description: 'Register (purchase) a new domain. Requires registrant contact info. ' +
            'Tech, admin, and billing contacts default to the registrant. ' +
            'Use check_domains first to confirm availability and pricing.',
        inputSchema: {
            domainName: z.string().describe('Domain to register, e.g. "example.com"'),
            years: z.number().int().min(1).max(10).describe('Registration period in years (1–10)'),
            firstName: z.string().describe('Registrant first name'),
            lastName: z.string().describe('Registrant last name'),
            address1: z.string().describe('Registrant address line 1'),
            address2: z.string().optional().describe('Registrant address line 2'),
            city: z.string().describe('Registrant city'),
            stateProvince: z.string().describe('Registrant state or province'),
            postalCode: z.string().describe('Registrant postal / ZIP code'),
            country: z.string().describe('Registrant 2-letter country code, e.g. "US"'),
            phone: z.string().describe('Registrant phone in +CountryCode.Number format, e.g. "+1.5555551234"'),
            emailAddress: z.string().describe('Registrant email address'),
            nameservers: z.string().optional().describe('Comma-separated custom nameservers. Omit to use Namecheap default DNS.'),
            addWhoisGuard: z.boolean().optional().describe('Add free WHOIS guard privacy if available (default: true)'),
            organizationName: z.string().optional().describe('Organization name (leave blank for individual registrants)'),
            confirmMutation: z.literal(true).describe('Must be true to approve this billable domain registration.'),
        },
    }, async ({ domainName, years, firstName, lastName, address1, address2, city, stateProvince, postalCode, country, phone, emailAddress, nameservers, addWhoisGuard, organizationName }) => {
        try {
            const client = requireClient(getClient);
            const buildContact = (prefix) => ({
                [`${prefix}FirstName`]: firstName,
                [`${prefix}LastName`]: lastName,
                [`${prefix}OrganizationName`]: organizationName ?? '',
                [`${prefix}Address1`]: address1,
                [`${prefix}Address2`]: address2 ?? '',
                [`${prefix}City`]: city,
                [`${prefix}StateProvince`]: stateProvince,
                [`${prefix}PostalCode`]: postalCode,
                [`${prefix}Country`]: country,
                [`${prefix}Phone`]: phone,
                [`${prefix}EmailAddress`]: emailAddress,
            });
            const wg = (addWhoisGuard ?? true) ? 'yes' : 'no';
            const params = {
                DomainName: domainName,
                Years: years,
                ...buildContact('Registrant'),
                ...buildContact('Tech'),
                ...buildContact('Admin'),
                ...buildContact('AuxBilling'),
                AddFreeWhoisguard: wg,
                WGEnabled: wg,
            };
            if (nameservers)
                params['Nameservers'] = nameservers;
            const result = await client.execute('namecheap.domains.create', params);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('get_domain_contacts', {
        description: 'Get WHOIS contact information for a domain: registrant, tech, admin, and billing contacts.',
        inputSchema: { domainName: z.string().describe('The domain name, e.g. "example.com"') },
    }, async ({ domainName }) => {
        try {
            const result = await requireClient(getClient).execute('namecheap.domains.getContacts', { DomainName: domainName });
            const r = result?.['DomainContactsResult'];
            if (!r)
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            const extractContact = (raw) => !raw ? null : ({
                firstName: raw['FirstName'],
                lastName: raw['LastName'],
                organization: raw['OrganizationName'],
                address1: raw['Address1'],
                address2: raw['Address2'],
                city: raw['City'],
                stateProvince: raw['StateProvince'],
                postalCode: raw['PostalCode'],
                country: raw['Country'],
                phone: raw['Phone'],
                fax: raw['Fax'],
                email: raw['EmailAddress'],
            });
            const clean = {
                domain: r['@_Domain'],
                registrant: extractContact(r['Registrant']),
                tech: extractContact(r['Tech']),
                admin: extractContact(r['Admin']),
                billing: extractContact(r['AuxBilling']),
            };
            return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('set_domain_contacts', {
        description: 'Update WHOIS contact information for a domain. ' +
            'All contact types (tech, admin, billing) are set to the provided values. ' +
            'All contact fields are required by the Namecheap API.',
        inputSchema: {
            domainName: z.string().describe('The domain name, e.g. "example.com"'),
            firstName: z.string().describe('First name'),
            lastName: z.string().describe('Last name'),
            address1: z.string().describe('Address line 1'),
            address2: z.string().optional().describe('Address line 2'),
            city: z.string().describe('City'),
            stateProvince: z.string().describe('State or province'),
            postalCode: z.string().describe('Postal / ZIP code'),
            country: z.string().describe('2-letter country code, e.g. "US"'),
            phone: z.string().describe('Phone in +CountryCode.Number format, e.g. "+1.5555551234"'),
            emailAddress: z.string().describe('Email address'),
            organizationName: z.string().optional().describe('Organization name'),
            confirmMutation: z.literal(true).describe('Must be true to approve this registrar contact mutation.'),
        },
    }, async ({ domainName, firstName, lastName, address1, address2, city, stateProvince, postalCode, country, phone, emailAddress, organizationName }) => {
        try {
            const buildContact = (prefix) => ({
                [`${prefix}FirstName`]: firstName,
                [`${prefix}LastName`]: lastName,
                [`${prefix}OrganizationName`]: organizationName ?? '',
                [`${prefix}Address1`]: address1,
                [`${prefix}Address2`]: address2 ?? '',
                [`${prefix}City`]: city,
                [`${prefix}StateProvince`]: stateProvince,
                [`${prefix}PostalCode`]: postalCode,
                [`${prefix}Country`]: country,
                [`${prefix}Phone`]: phone,
                [`${prefix}EmailAddress`]: emailAddress,
            });
            const params = {
                DomainName: domainName,
                ...buildContact('Registrant'),
                ...buildContact('Tech'),
                ...buildContact('Admin'),
                ...buildContact('AuxBilling'),
            };
            const result = await requireClient(getClient).execute('namecheap.domains.setContacts', params);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('reactivate_domain', {
        description: 'Reactivate a recently expired domain.',
        inputSchema: {
            domainName: z.string().describe('The expired domain name, e.g. "example.com"'),
            years: z.number().int().min(1).max(10).describe('Number of years to reactivate for'),
            confirmMutation: z.literal(true).describe('Must be true to approve this billable domain reactivation.'),
        },
    }, async ({ domainName, years }) => {
        try {
            const result = await requireClient(getClient).execute('namecheap.domains.reactivate', {
                DomainName: domainName,
                YearsToAdd: years,
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
    server.registerTool('renew_whoisguard', {
        description: 'Renew WHOIS guard (privacy protection) for a domain. WHOIS guard renewal is separate from domain renewal.',
        inputSchema: {
            domainName: z.string().describe('The domain name, e.g. "example.com"'),
            years: z.number().int().min(1).max(5).describe('Number of years to renew WHOIS guard for (1–5)'),
            confirmMutation: z.literal(true).describe('Must be true to approve this billable domain-privacy renewal.'),
        },
    }, async ({ domainName, years }) => {
        try {
            const client = requireClient(getClient);
            const subscription = await resolvePrivacySubscription(client, domainName);
            if (!subscription?.id) {
                return failClosed('PRIVACY_SUBSCRIPTION_NOT_FOUND', `No exact domain-privacy subscription ID was found for ${domainName}; refusing to renew.`, { domain: domainName });
            }
            const result = await client.execute('namecheap.whoisguard.renew', {
                WhoisguardId: subscription.id,
                Years: years,
            });
            const acknowledgement = parseWhoisguardRenewAcknowledgement(result, subscription.id);
            if (!acknowledgement.acknowledged || !acknowledgement.idMatches) {
                return failClosed('PRIVACY_RENEWAL_NOT_ACKNOWLEDGED', 'Namecheap did not return a successful renewal acknowledgement for the exact domain-privacy subscription ID.', { domain: domainName, acknowledgement });
            }
            const readback = await readExactPrivacySubscription(client, domainName);
            if (!readback || readback.id !== subscription.id) {
                return failClosed('PRIVACY_RENEWAL_READBACK_MISMATCH', 'Namecheap acknowledged the renewal, but exact-domain subscription readback did not confirm the same privacy ID.', { domain: domainName, expectedPrivacyId: subscription.id, readbackPrivacyId: readback?.id ?? null });
            }
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            domain: domainName,
                            years,
                            renewalAcknowledged: true,
                            readbackVerified: true,
                            privacyStatus: readback.status,
                            privacyExpires: readback.expires,
                        }, null, 2),
                    }],
            };
        }
        catch (err) {
            return toErrorResult(err);
        }
    });
}
//# sourceMappingURL=domains.js.map