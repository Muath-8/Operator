'use client';

import { useEffect } from 'react';

/**
 * Error boundary: say what failed and what happens next (UX 6.1, never apology theatre).
 * Nothing binding happens client-side, so a render error can never have decided, sent or paid anything.
 * Strings follow the document language set by the layout.
 */
const COPY = {
  en: {
    title: 'The workspace hit an error.',
    body: 'Nothing was decided, sent or paid because of it. Your mission is safe in the ledger.',
    retry: 'Reload the workspace',
    ref: 'Reference',
  },
  ar: {
    title: 'واجهت مساحة العمل خطأ.',
    body: 'لم يُتّخذ قرار ولم يُرسل أو يُدفع شيء بسببه. مهمتك محفوظة في السجل.',
    retry: 'أعد تحميل مساحة العمل',
    ref: 'المرجع',
  },
} as const;

export default function WorkspaceError({ error, reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  useEffect(() => {
    // Report the digest only; never the message, which could carry mission content.
    if (error.digest) console.error('workspace error', error.digest);
  }, [error.digest]);
  const lang = typeof document !== 'undefined' && document.documentElement.lang === 'ar' ? 'ar' : 'en';
  const c = COPY[lang];
  return (
    <main className="main" style={{ blockSize: '100dvh' }}>
      <article className="page" role="alert">
        <h1 className="title">{c.title}</h1>
        <p className="lede" style={{ marginBlockStart: 'var(--sp-6)' }}>
          {c.body}
        </p>
        <div style={{ marginBlockStart: 'var(--sp-6)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
          <button type="button" className="btn primary" onClick={reset}>
            {c.retry}
          </button>
          {error.digest ? (
            <span className="muted">
              {c.ref} {error.digest}
            </span>
          ) : null}
        </div>
      </article>
    </main>
  );
}
