import { z } from 'zod';
import {
  FxCurrencySchema,
  FxConversionSchema,
  conservativeConvertedMinor,
  fetchTransport,
  hashPayload,
  type FxConversion,
  type Transport,
} from '@lo/adapters';
import type { Result } from '@lo/state';
import { withRole, type ActorScope } from './database.js';

export const SAMA_FX_SOURCE = 'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx';
export const SAMA_FX_ENDPOINT = 'https://www.sama.gov.sa/en-US/_LAYOUTS/15/SAMA.Portal/PortalHandler.ashx';
const rowSchema = z.object({
  CurrencyCode: z.string(),
  CurrencyRate: z.number().finite().positive(),
  CurrencyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00$/),
});
/** Read-only first-party SAMA daily reference rates. No model URL, supplied exchange rate or guessed peg is accepted. */
export async function fetchAuthoritativeFxQuote(
  scope: ActorScope,
  raw: unknown,
  transport: Transport = fetchTransport,
): Promise<Result<FxConversion>> {
  try {
    const input = z
      .object({ amountMinor: z.number().int().nonnegative().safe(), from: FxCurrencySchema, to: FxCurrencySchema })
      .strict()
      .parse(raw);
    if (input.from === input.to)
      return {
        ok: false,
        error: { code: 'validation', message: 'Same-currency payments do not need a conversion quote.', retryable: false },
      };
    // Verify tenant ownership before spending provider/network work.
    await withRole('policy_role', scope, async db => {
      if (!(await db.query('select id from public.effective_missions where id=$1', [scope.missionId])).rows[0])
        throw new Error('Mission scope denied');
    });
    const load = async (currency: z.infer<typeof FxCurrencySchema>) => {
      const url = new URL(SAMA_FX_ENDPOINT);
      url.search = new URLSearchParams({
        op: 'filterCurrenciesWithCount',
        isArabic: 'false',
        code: `${currency}=`,
        date: '',
        page: '0',
        limit: '1',
      }).toString();
      const response = await transport({ url: url.href, method: 'GET', headers: { Accept: 'application/json' } });
      if (response.status !== 200) throw new Error('SAMA rate source unavailable');
      const data = z.object({ data: z.array(rowSchema).length(1) }).parse(response.body).data[0];
      if (!data || data.CurrencyCode !== `${currency}=`) throw new Error('SAMA currency correlation mismatch');
      return data;
    };
    const [from, to] = await Promise.all([input.from === 'SAR' ? null : load(input.from), input.to === 'SAR' ? null : load(input.to)]);
    const date = from?.CurrencyDate ?? to?.CurrencyDate;
    if (!date || (from && to && from.CurrencyDate !== to.CurrencyDate)) throw new Error('SAMA cross-rates do not share a source date');
    const rates = {
      from: from ?? { CurrencyCode: 'SAR=', CurrencyRate: 1, CurrencyDate: date },
      to: to ?? { CurrencyCode: 'SAR=', CurrencyRate: 1, CurrencyDate: date },
    };
    const result = await withRole(
      'policy_role',
      scope,
      async db =>
        (
          await db.query('select public.record_fx_quote($1,$2,$3,$4,$5)result', [
            scope.missionId,
            input.from,
            input.to,
            rates,
            hashPayload(rates),
          ])
        ).rows[0]?.result,
    );
    const quote = FxConversionSchema.omit({ missionAmountMinor: true }).parse(result);
    return {
      ok: true,
      value: FxConversionSchema.parse({
        ...quote,
        missionAmountMinor: conservativeConvertedMinor(input.amountMinor, quote.numerator, quote.denominator),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof z.ZodError ? 'validation' : 'provider_down',
        message: 'A current dated authoritative FX quote is unavailable. Cross-currency payment remains blocked; no rate was inferred.',
        retryable: false,
      },
    };
  }
}
