import type { AccountsView, DeletionNotice } from '../../../src/ui-contract';
import { parseAccounts } from '../../../src/components/account/accountApi';

/**
 * TEST FIXTURE ONLY, raw API shape (docs/implementation/ACCOUNT-API.md): one passed check, one
 * unverified (must read "Verification pending"), one revoked.
 */
export const ACCOUNTS_RESPONSE = {
  ok: true,
  value: {
    accounts: [
      {
        accountId: '10000000-0000-4000-8000-000000000001',
        counterpartyId: null,
        provider: 'resend',
        status: 'connected',
        sandboxMode: true,
        verification: { status: 'authenticated', checkedAt: '2026-11-10T09:00:00.000Z', reason: null, ownership: 'founder_attested' },
        scopes: ['send_email', 'read_delivery_status'],
        createdAt: '2026-11-09T12:00:00.000Z',
      },
      {
        accountId: '10000000-0000-4000-8000-000000000002',
        counterpartyId: null,
        provider: 'paypal',
        status: 'connected',
        sandboxMode: true,
        verification: {
          status: 'unverified',
          checkedAt: '2026-11-11T09:00:00.000Z',
          reason: 'The key is restricted to read-only invoices; the account check could not complete.',
          ownership: 'founder_attested',
        },
        scopes: ['create_invoice'],
        createdAt: '2026-11-10T12:00:00.000Z',
      },
      {
        accountId: '10000000-0000-4000-8000-000000000003',
        counterpartyId: null,
        provider: 'twilio',
        status: 'revoked',
        sandboxMode: true,
        verification: { status: 'authenticated', checkedAt: '2026-11-08T09:00:00.000Z', reason: null, ownership: 'founder_attested' },
        scopes: ['send_whatsapp'],
        createdAt: '2026-11-08T12:00:00.000Z',
      },
    ],
  },
};
export const ACCOUNTS: AccountsView = parseAccounts(ACCOUNTS_RESPONSE);

/** TEST FIXTURE ONLY: account-surface data for the harness. */
export const DELETION_NOTICE: DeletionNotice = {
  retainedAccounts: [
    { id: 'acc-1', label: 'Domain registrar', detail: 'active' },
    { id: 'acc-2', label: 'Store', detail: 'active' },
  ],
  retainedExternalAssets: [
    { id: 'as-1', label: 'Brand directions', detail: 'visual, approved' },
    { id: 'as-2', label: 'Product spec v2', detail: 'document, stale' },
  ],
  notice: 'External accounts, domains, stores and supplier assets remain yours. Mission records and private files will be removed.',
};

export const VALIDATION_PAGE = {
  slug: 'sandbox-test',
  title: 'A quiet evening, bottled',
  description: 'A small first run of a modern Arabian floral. Leave your email and we will write once, when the first bottles are ready.',
  consentText: 'I agree to receive one email about this launch. I can ask for my email to be deleted at any time.',
  imageUrl: null,
  sandbox: true,
};
