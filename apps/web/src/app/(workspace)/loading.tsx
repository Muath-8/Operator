import { cookies } from 'next/headers';

/**
 * Workspace-only loading state: the shell in place with skeletons at their final sizes, replaced in place, never
 * appended (UX 11, sequence 3). No spinner theatre; the strip says what is happening.
 */
export default async function Loading() {
  const lang = (await cookies()).get('lo-lang')?.value === 'ar' ? 'ar' : 'en';
  const label = lang === 'ar' ? 'جارٍ تحميل المهمة' : 'Loading the mission';
  return (
    <div className="app" aria-busy="true">
      <header className="strip">
        <div className="working sk-working" role="status">
          <i className="dot" aria-hidden="true" />
          <span>{label}</span>
        </div>
      </header>
      <div className="banners" />
      <div className="below">
        <nav className="rail" aria-hidden="true" />
        <main className="main">
          <article className="page" aria-hidden="true">
            <div className="sk sk-title" />
            <div className="sk sk-line" />
            <div className="sk sk-lede" />
            <div className="sk sk-body" />
          </article>
        </main>
      </div>
    </div>
  );
}
