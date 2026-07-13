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
export declare function normalizeDomain(value: string): string;
export declare function parseTriStateBoolean(value: unknown): boolean | null;
export declare function findExactDomainListEntry(result: unknown, domainName: string): RawRecord | null;
export declare function parseDomainInfoResult(result: unknown, domainName: string): RawRecord;
export declare function parseRegistrarLockResult(result: unknown, domainName: string): boolean | null;
export declare function mergeDomainState(domainName: string, listResult: unknown, infoResult: unknown, registrarLockResult: unknown): DomainState;
export declare function findExactPrivacySubscription(result: unknown, domainName: string): PrivacySubscription | null;
export declare function parseMutationAcknowledgement(result: unknown, envelopeName: string, domainName: string): {
    acknowledged: boolean;
    domainMatches: boolean;
    responseDomain: string | null;
};
export declare function parseWhoisguardRenewAcknowledgement(result: unknown, expectedId: string): {
    acknowledged: boolean;
    idMatches: boolean;
    responseId: string | null;
};
export declare function parsePrivacyFromInfoResult(result: unknown, domainName: string): DomainPrivacyState;
