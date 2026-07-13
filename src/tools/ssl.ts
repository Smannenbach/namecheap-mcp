import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NamecheapClient } from '../client.js';
import { requireClient } from '../config.js';
import { toErrorResult } from '../errors.js';

export function registerSslTools(server: McpServer, getClient: () => NamecheapClient | null): void {

  server.registerTool(
    'list_ssl_certs',
    {
      description: 'List SSL certificates in your Namecheap account, including status, expiry, and associated domain.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Results per page, max 100 (default: 20)'),
      },
    },
    async ({ page, pageSize }) => {
      try {
        const result = await requireClient(getClient).execute('namecheap.ssl.getList', {
          Page: page ?? 1,
          PageSize: pageSize ?? 20,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'create_ssl_cert',
    {
      description: 'Purchase a new SSL certificate. Common types: PositiveSSL, EssentialSSL, InstantSSL, PositiveSSL Wildcard, PremiumSSL Wildcard.',
      inputSchema: {
        type: z.string().describe('Certificate product type, e.g. "PositiveSSL", "PositiveSSL Wildcard"'),
        years: z.number().int().min(1).max(3).describe('Certificate validity in years (1–3)'),
        confirmMutation: z.literal(true).describe('Must be true to approve this billable SSL purchase.'),
      },
    },
    async ({ type, years }) => {
      try {
        const result = await requireClient(getClient).execute('namecheap.ssl.create', { Type: type, Years: years });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'get_ssl_info',
    {
      description: 'Get details for a specific SSL certificate: status, domain, expiry, CSR, approver email, and validation info.',
      inputSchema: {
        certificateId: z.number().int().describe('The certificate ID from list_ssl_certs'),
      },
    },
    async ({ certificateId }) => {
      try {
        const result = await requireClient(getClient).execute('namecheap.ssl.getInfo', { CertificateID: certificateId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'activate_ssl',
    {
      description:
        'Activate a purchased SSL certificate by submitting a CSR and admin contact info. ' +
        'Choose one DCV method: approverEmail (email validation), httpDcv (HTTP file), or cnameDcv (CNAME record). ' +
        'Use get_ssl_info to find valid approver emails for the domain.',
      inputSchema: {
        certificateId: z.number().int().describe('The certificate ID from list_ssl_certs or create_ssl_cert'),
        csr: z.string().describe('PEM-encoded Certificate Signing Request (CSR)'),
        adminFirstName: z.string().describe('Admin contact first name'),
        adminLastName: z.string().describe('Admin contact last name'),
        adminAddress1: z.string().describe('Admin contact address line 1'),
        adminCity: z.string().describe('Admin contact city'),
        adminStateProvince: z.string().describe('Admin contact state or province'),
        adminPostalCode: z.string().describe('Admin contact postal code'),
        adminCountry: z.string().describe('Admin contact 2-letter country code, e.g. "US"'),
        adminPhone: z.string().describe('Admin contact phone, e.g. "+1.5555551234"'),
        adminEmailAddress: z.string().describe('Admin contact email address'),
        approverEmail: z.string().optional().describe('Email address for DCV approval (must be admin@, webmaster@, etc. for the domain)'),
        httpDcv: z.boolean().optional().describe('Use HTTP file-based domain control validation'),
        cnameDcv: z.boolean().optional().describe('Use CNAME-based domain control validation'),
        confirmMutation: z.literal(true).describe('Must be true to approve this certificate activation.'),
      },
    },
    async ({ certificateId, csr, adminFirstName, adminLastName, adminAddress1, adminCity, adminStateProvince, adminPostalCode, adminCountry, adminPhone, adminEmailAddress, approverEmail, httpDcv, cnameDcv }) => {
      try {
        const dcvCount = [approverEmail, httpDcv, cnameDcv].filter(Boolean).length;
        if (dcvCount !== 1) {
          return { content: [{ type: 'text', text: 'Provide exactly one DCV method: approverEmail, httpDcv, or cnameDcv.' }], isError: true };
        }
        const params: Record<string, string | number> = {
          CertificateID: certificateId,
          CSR: csr,
          AdminFirstName: adminFirstName,
          AdminLastName: adminLastName,
          AdminAddress1: adminAddress1,
          AdminCity: adminCity,
          AdminStateProvince: adminStateProvince,
          AdminPostalCode: adminPostalCode,
          AdminCountry: adminCountry,
          AdminPhone: adminPhone,
          AdminEmailAddress: adminEmailAddress,
        };
        if (approverEmail) params['ApproverEmail'] = approverEmail;
        if (httpDcv) params['HTTPDCValidation'] = 'True';
        if (cnameDcv) params['CNAMEDCV'] = 'True';

        const result = await requireClient(getClient).execute('namecheap.ssl.activate', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    'reissue_ssl',
    {
      description:
        'Reissue an SSL certificate with a new CSR (e.g. after key rotation or adding SANs). ' +
        'Choose one DCV method: approverEmail, httpDcv, or cnameDcv.',
      inputSchema: {
        certificateId: z.number().int().describe('The certificate ID to reissue'),
        csr: z.string().describe('New PEM-encoded CSR'),
        adminEmailAddress: z.string().describe('Admin email address'),
        adminFirstName: z.string().describe('Admin first name'),
        adminLastName: z.string().describe('Admin last name'),
        adminAddress1: z.string().describe('Admin address line 1'),
        adminCity: z.string().describe('Admin city'),
        adminStateProvince: z.string().describe('Admin state or province'),
        adminPostalCode: z.string().describe('Admin postal code'),
        adminCountry: z.string().describe('Admin 2-letter country code'),
        adminPhone: z.string().describe('Admin phone, e.g. "+1.5555551234"'),
        approverEmail: z.string().optional().describe('Approver email for DCV'),
        httpDcv: z.boolean().optional().describe('Use HTTP file-based DCV'),
        cnameDcv: z.boolean().optional().describe('Use CNAME-based DCV'),
        confirmMutation: z.literal(true).describe('Must be true to approve this certificate reissue.'),
      },
    },
    async ({ certificateId, csr, adminEmailAddress, adminFirstName, adminLastName, adminAddress1, adminCity, adminStateProvince, adminPostalCode, adminCountry, adminPhone, approverEmail, httpDcv, cnameDcv }) => {
      try {
        const dcvCount = [approverEmail, httpDcv, cnameDcv].filter(Boolean).length;
        if (dcvCount !== 1) {
          return { content: [{ type: 'text', text: 'Provide exactly one DCV method: approverEmail, httpDcv, or cnameDcv.' }], isError: true };
        }
        const params: Record<string, string | number> = {
          CertificateID: certificateId,
          CSR: csr,
          AdminEmailAddress: adminEmailAddress,
          AdminFirstName: adminFirstName,
          AdminLastName: adminLastName,
          AdminAddress1: adminAddress1,
          AdminCity: adminCity,
          AdminStateProvince: adminStateProvince,
          AdminPostalCode: adminPostalCode,
          AdminCountry: adminCountry,
          AdminPhone: adminPhone,
        };
        if (approverEmail) params['ApproverEmail'] = approverEmail;
        if (httpDcv) params['HTTPDCValidation'] = 'True';
        if (cnameDcv) params['CNAMEDCV'] = 'True';

        const result = await requireClient(getClient).execute('namecheap.ssl.reissue', params);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );
}
