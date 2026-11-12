import { en } from '../../i18n/en';

/** Operator signature for account surfaces. Mission strips retain the founder's mission name. */
export function BrandLockup({ label }: { readonly label: string }) {
  return (
    <span className="brand-lockup" role="img" aria-label={label}>
      <svg viewBox="0 0 32 28" aria-hidden="true" focusable="false">
        <path d="M8 0h8a8 8 0 0 1 8 8v2h-6V8a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2h6v2a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8V8a8 8 0 0 1 8-8Z" />
        <path d="M26 11h6v6h-6Z" />
      </svg>
      <span className="brand-wordmark" lang="en" dir="ltr" aria-hidden="true">
        {en.appName.toLowerCase()}
      </span>
    </span>
  );
}
