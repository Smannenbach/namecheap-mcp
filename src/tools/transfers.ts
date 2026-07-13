import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NamecheapClient } from '../client.js';
import { requireClient } from '../config.js';
import { toErrorResult } from '../errors.js';

export function registerTransferTools(server: McpServer, getClient: () => NamecheapClient | null): void {

  server.registerTool(
    'transfer_domain',
    {
      description:
        'Transfer a domain from another registrar to Namecheap. ' +
        'You must unlock the domain and obtain its EPP/auth code from the current registrar first. ' +
        'Use get_tld_list to confirm the TLD is API-transferable.',
      inputSchema: {
        domainName: z.string().describe('Domain to transfer, e.g. "example.com"'),
        years: z.number().int().min(1).max(10).describe('Years to add upon transfer (1–10)'),
        eppCode: z.string().describe('EPP / auth code from the current registrar'),
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
        addWhoisGuard: z.boolean().optional().describe('Add free WHOIS guard privacy if available (default: true)'),
        confirmMutation: z.literal(true).describe('Must be true to approve this billable inbound domain transfer.'),
      },
    },
    async ({ domainName, years, eppCode, firstName, lastName, address1, address2, city, stateProvince, postalCode, country, phone, emailAddress, addWhoisGuard }) => {
      try {
        const buildContact = (prefix: string) => ({
          [`${prefix}FirstName`]: firstName,
          [`${prefix}LastName`]: lastName,
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
        const params: Record<string, string | number> = {
          DomainName: domainName,
          Years: years,
          EPPCode: eppCode,
          ...buildContact('Registrant'),
          ...buildContact('Tech'),
          ...buildContact('Admin'),
          ...buildContact('AuxBilling'),
          AddFreeWhoisguard: wg,
          WGEnabled: wg,
        };

        const result = await requireClient(getClient).execute('namecheap.domains.transfer.create', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'get_transfer_status',
    {
      description: 'Get the current status of a domain transfer by its transfer ID.',
      inputSchema: {
        transferId: z.number().int().describe('The transfer ID returned by transfer_domain'),
      },
    },
    async ({ transferId }) => {
      try {
        const result = await requireClient(getClient).execute('namecheap.domains.transfer.getStatus', {
          TransferID: transferId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'list_transfers',
    {
      description: 'List domain transfers in your Namecheap account with optional filtering by status.',
      inputSchema: {
        listType: z.enum(['ALL', 'INPROGRESS', 'CANCELLED', 'COMPLETED']).optional().describe('Filter by transfer status (default: ALL)'),
        searchTerm: z.string().optional().describe('Filter by domain name substring'),
        page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Results per page, max 100 (default: 20)'),
      },
    },
    async ({ listType, searchTerm, page, pageSize }) => {
      try {
        const params: Record<string, string | number> = {
          Page: page ?? 1,
          PageSize: pageSize ?? 20,
        };
        if (listType) params['ListType'] = listType;
        if (searchTerm) params['SearchTerm'] = searchTerm;

        const result = await requireClient(getClient).execute('namecheap.domains.transfer.getList', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );
}
