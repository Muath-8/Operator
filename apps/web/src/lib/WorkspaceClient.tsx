'use client';
import { translate } from '../i18n/messages';
import { MissionWorkspace } from '../components/MissionWorkspace';
import { useMissionController, type ControllerOptions } from './useMissionController';
import type { Target } from '../ui-contract';
export function WorkspaceClient(props: ControllerOptions & { initialTarget?: Target | null }) {
  const controller = useMissionController(props);
  if (props.localBackend !== 'sqlite') return <MissionWorkspace {...controller} initialTarget={props.initialTarget} />;
  const t = (key: Parameters<typeof translate>[1]) => translate(controller.language, key);
  return (
    <div className="local-testing-workspace">
      <aside className="banner sandbox" role="note" lang={controller.language} dir={controller.language === 'ar' ? 'rtl' : 'ltr'}>
        <span className="grow">
          <strong>{t('local_title')}</strong> {t(props.localAi === 'codex' ? 'local_codex' : 'local_simulated')}
        </span>
        <a className="btn line sm" href="/local/paypal">
          {t('local_paypal')}
        </a>
        <details>
          <summary>{t('local_help')}</summary>
          <p>{t('local_explain')}</p>
        </details>
      </aside>
      <MissionWorkspace {...controller} initialTarget={props.initialTarget} />
    </div>
  );
}
