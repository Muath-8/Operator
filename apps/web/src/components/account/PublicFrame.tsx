import type { ReactNode } from 'react';

/**
 * Frame for pages outside a mission (sign-in, onboarding, public validation pages): the same strip,
 * paper and 680px measure as the workspace, with no rail and no peek. Server-safe.
 */
export function PublicFrame({
  strip,
  children,
  lang,
}: {
  readonly strip: ReactNode;
  readonly children: ReactNode;
  readonly lang?: string;
}) {
  return (
    <div className="pub">
      <header className="strip pub-strip">{strip}</header>
      <main className="pub-main" id="main" lang={lang}>
        <article className="page pub-page">{children}</article>
      </main>
    </div>
  );
}
