import { z } from 'zod';
/** All supported payment currencies use two minor digits. Reference conversion is budget/accounting, not a bank debit assertion. */
export const FxCurrencySchema = z.enum(['USD', 'SAR', 'EUR', 'GBP', 'AED']);
export const FxConversionSchema = z
  .object({
    quoteId: z.uuid(),
    from: FxCurrencySchema,
    to: FxCurrencySchema,
    numerator: z.number().int().positive().safe(),
    denominator: z.number().int().positive().safe(),
    source: z.literal('https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx'),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    missionAmountMinor: z.number().int().nonnegative().safe(),
  })
  .strict();
export type FxConversion = z.infer<typeof FxConversionSchema>;
export function conservativeConvertedMinor(amount: number, numerator: number, denominator: number): number {
  z.number().int().nonnegative().safe().parse(amount);
  z.number().int().positive().safe().parse(numerator);
  z.number().int().positive().safe().parse(denominator);
  const result = (BigInt(amount) * BigInt(numerator) + BigInt(denominator) - 1n) / BigInt(denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Converted amount exceeds supported integer range');
  return Number(result);
}
