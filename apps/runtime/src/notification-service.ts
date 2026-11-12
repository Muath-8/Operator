import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { withRole, type ActorScope } from './database.js';
import { notificationDelivery, type NotificationClass } from './notifications.js';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const NotificationSettingsSchema = z
  .object({
    timeZone: z.string().min(1),
    locale: z.enum(['en', 'ar']),
    digestCadence: z.enum(['daily', 'twice_weekly', 'weekly']),
    digestHour: z.number().int().min(0).max(23),
    quietHours: z
      .object({ from: z.string().regex(TIME), to: z.string().regex(TIME) })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((p, c) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: p.timeZone });
    } catch {
      c.addIssue({ code: 'custom', path: ['timeZone'], message: 'An IANA time zone is required' });
    }
  });
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export interface NotificationSchedule {
  dueAt: string;
  delivery: 'immediate' | 'digest' | 'after_quiet_hours';
}
interface ExistingSchedule extends NotificationSchedule {
  configurationHash: string;
}
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(date: Date, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const p = formatter.formatToParts(date);
  const get = (key: string) => Number(p.find(part => part.type === key)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}
const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function quiet(date: Date, p: NotificationSettings): boolean {
  if (!p.quietHours) return false;
  const at = localParts(date, p.timeZone),
    value = at.hour * 60 + at.minute,
    start = minute(p.quietHours.from),
    end = minute(p.quietHours.to);
  return start === end ? false : start < end ? value >= start && value < end : value >= start || value < end;
}
function calendarDay(parts: LocalParts, offset: number): LocalParts {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset));
  return { ...parts, year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
}
/** Resolve local wall time using installed ICU time-zone rules. The bounded scan
 * handles skipped/repeated clock minutes without assuming a fixed UTC offset. */
function wallTime(parts: LocalParts, targetMinute: number, timeZone: string, after = -Infinity): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, Math.floor(targetMinute / 60), targetMinute % 60);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const actual = localParts(new Date(guess), timeZone);
    guess += target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  for (let value = guess - 180 * 60000; value <= guess + 180 * 60000; value += 60000) {
    const actual = localParts(new Date(value), timeZone);
    if (
      value > after &&
      actual.year === parts.year &&
      actual.month === parts.month &&
      actual.day === parts.day &&
      actual.hour * 60 + actual.minute >= targetMinute
    )
      return new Date(value);
  }
  throw new Error('validation: local notification time cannot be resolved');
}
function quietEnd(date: Date, p: NotificationSettings): Date {
  if (!p.quietHours) return date;
  const local = localParts(date, p.timeZone),
    start = minute(p.quietHours.from),
    end = minute(p.quietHours.to);
  const next = start > end && local.hour * 60 + local.minute >= start ? calendarDay(local, 1) : local;
  return wallTime(next, end, p.timeZone, date.getTime());
}
function nextDigest(createdAt: Date, p: NotificationSettings): Date {
  const start = localParts(createdAt, p.timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const day = calendarDay(start, offset),
      weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
    if ((p.digestCadence === 'weekly' && weekday !== 1) || (p.digestCadence === 'twice_weekly' && weekday !== 1 && weekday !== 4)) continue;
    const due = wallTime(day, p.digestHour * 60, p.timeZone);
    if (due > createdAt) return quiet(due, p) ? quietEnd(due, p) : due;
  }
  throw new Error('invariant_violation: digest cadence has no next date');
}
export function notificationConfigurationHash(settings: NotificationSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}
/** Scheduling is deterministic from source time, current preferences and clock.
 * Only mandate and payment-failure events break quiet hours, as in the existing
 * notificationDelivery policy. Digest weekdays are Monday / Monday+Thursday. */
export function scheduleNotification(
  kind: NotificationClass,
  createdAt: Date,
  now: Date,
  settings: NotificationSettings,
  existing?: ExistingSchedule,
): NotificationSchedule {
  const p = NotificationSettingsSchema.parse(settings);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(now.getTime())) throw new Error('validation: notification clock invalid');
  const base = notificationDelivery(kind, now, {
    timeZone: p.timeZone,
    quietStartHour: 0,
    quietEndHour: 0,
    digestHour: p.digestHour,
    locale: p.locale,
  });
  if (kind === 'mandate' || kind === 'payment_failure') return { dueAt: createdAt.toISOString(), delivery: 'immediate' };
  const same = existing?.configurationHash === notificationConfigurationHash(p);
  let due = same ? new Date(existing.dueAt) : base === 'digest' ? nextDigest(createdAt, p) : createdAt;
  let delivery: NotificationSchedule['delivery'] =
    base === 'digest' ? 'digest' : same && existing.delivery === 'after_quiet_hours' ? 'after_quiet_hours' : 'immediate';
  if (due <= now && quiet(now, p)) {
    due = quietEnd(now, p);
    if (base !== 'digest') delivery = 'after_quiet_hours';
  } else if (due > now && quiet(due, p)) {
    due = quietEnd(due, p);
    if (base !== 'digest') delivery = 'after_quiet_hours';
  }
  return { dueAt: due.toISOString(), delivery };
}

const SourceSchema = z.object({
  id: z.uuid(),
  source_table: z.enum([
    'decisions',
    'payment_states',
    'effect_states',
    'run_results',
    'activity',
    'effect_authorizations',
    'money_ledger',
  ]),
  source_id: z.uuid(),
  class: z.enum(['decision', 'mandate', 'payment_executed', 'payment_failure', 'blocking_failure', 'recommendation_changed', 'routine']),
  created_at: z.coerce.date(),
  schedule: z
    .object({ configuration_hash: z.string(), due_at: z.coerce.date(), delivery: z.enum(['immediate', 'digest', 'after_quiet_hours']) })
    .passthrough()
    .nullable(),
  data: JsonObjectSchema,
});
type Source = z.infer<typeof SourceSchema>;
const text = (data: Record<string, JsonValue>, key: string, fallback = ''): string =>
  typeof data[key] === 'string' ? data[key] : fallback;
const integer = (value: JsonValue | undefined): bigint => {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error('validation: exact notification money required');
};
/** Format integer minor units exactly, including currencies with0/3 decimals. */
export function notificationMoney(amount: string, currency: string, locale: 'ar' | 'en'): string {
  const numericLocale = locale === 'ar' ? 'ar-u-nu-arab' : 'en',
    minor = integer(amount),
    fraction = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2,
    scale = 10n ** BigInt(fraction),
    whole = minor / scale,
    remainder = minor < 0n ? -(minor % scale) : minor % scale;
  const base = new Intl.NumberFormat(numericLocale, { maximumFractionDigits: 0 }).format(whole === 0n && minor < 0n ? -0 : whole);
  if (!fraction) return `${currency} ${base}`;
  const decimal =
    new Intl.NumberFormat(numericLocale, { minimumFractionDigits: 1 }).formatToParts(1.1).find(p => p.type === 'decimal')?.value ?? '.';
  const digits = String(remainder)
    .padStart(fraction, '0')
    .split('')
    .map(d => new Intl.NumberFormat(numericLocale, { useGrouping: false }).format(Number(d)))
    .join('');
  return `${currency} ${base}${decimal}${digits}`;
}
const localized = (p: NotificationSettings, en: string, ar: string) => (p.locale === 'ar' ? ar : en);
const clip = (value: string, length: number) => (value.length > length ? `${value.slice(0, length - 1)}…` : value);
const sourceQuery = `select source.*,to_jsonb(schedule)schedule,
case source.source_table
when 'decisions'then(select jsonb_build_object('decisionId',d.id,'question',d.packet->>'question','momentId',(select item.moment_id from public.decision_moment_items item where item.mission_id=d.mission_id and item.decision_id=d.id and source.source_key='moment:'||item.moment_id||':decision:'||item.decision_id),'inactive',exists(select from public.decision_resolutions r where r.decision_id=d.id and(r.response in('approve','choose','reject')or r.created_at>=source.created_at))or exists(select from public.stale_marks s where s.mission_id=d.mission_id and s.node_id=d.id)or exists(select from public.decision_supersessions s where s.previous_id=d.id))from public.decisions d where d.mission_id=source.mission_id and d.id=source.source_id)
when 'payment_states'then(select jsonb_build_object('state',state.state,'currentState',(select state from public.payment_states latest where latest.mission_id=state.mission_id and latest.payment_id=state.payment_id order by created_at desc,id desc limit 1),'payee',party.name,'amountMinor',p.amount_minor::text,'currency',p.currency,'purpose',p.purpose,'mandateId',authz.mandate_id,'sandboxMode',p.sandbox_mode)from public.payment_states state join public.payments p on p.mission_id=state.mission_id and p.id=state.payment_id join public.counterparties party on party.id=p.payee_id join public.effect_authorizations authz on authz.mission_id=p.mission_id and authz.id=p.authorization_id where state.mission_id=source.mission_id and state.id=source.source_id)
when 'effect_states'then(select jsonb_build_object('state',state.status,'currentState',(select status from public.effect_states latest where latest.mission_id=state.mission_id and latest.authorization_id=state.authorization_id order by created_at desc,id desc limit 1),'payee',party.name,'amountMinor',authz.intent->>'amountMinor','currency',authz.intent->>'currency','purpose',coalesce(authz.intent->>'purpose',authz.intent->>'action'),'mandateId',authz.mandate_id,'sandboxMode',authz.sandbox_mode)from public.effect_states state join public.effect_authorizations authz on authz.mission_id=state.mission_id and authz.id=state.authorization_id join public.counterparties party on party.id::text=authz.intent->>'counterpartyId' where state.mission_id=source.mission_id and state.id=source.source_id)
when 'effect_authorizations'then(select jsonb_build_object('mandateId',mandate.id,'ceilingMinor',mandate.ceiling_total::text,'currency',mandate.currency,'maxContacts',coalesce(mandate.scope->>'maxNewContacts','0'),'maxActions',coalesce(mandate.scope->>'maxActions','0'),'actions',(select count(*)::text from public.effect_authorizations a where a.mission_id=mandate.mission_id and a.mandate_id=mandate.id and a.intent->>'effectClass'='spend'),'usedMinor',public.mandate_usage(mandate.mission_id,mandate.id)->>'usedMinor','contacts',public.mandate_usage(mandate.mission_id,mandate.id)->>'contacts')from public.effect_authorizations authz join public.mandates mandate on mandate.mission_id=authz.mission_id and mandate.id=authz.mandate_id where authz.mission_id=source.mission_id and authz.id=source.source_id)
when 'activity'then(select jsonb_build_object('label',a.label,'summary',a.summary)from public.activity a where a.mission_id=source.mission_id and a.id=source.source_id)
when 'run_results'then(select jsonb_build_object('role',run.role,'status',result.result->>'status')from public.run_results result join public.runs run on run.mission_id=result.mission_id and run.id=result.run_id where result.mission_id=source.mission_id and result.id=source.source_id)
else '{}'::jsonb end data
from public.notification_sources source left join lateral(select *from public.notification_schedules s where s.mission_id=source.mission_id and s.source_id=source.id order by s.created_at desc,s.id desc limit 1)schedule on true
where source.mission_id=$1 and not exists(select from public.notification_releases release where release.source_id=source.id)and not exists(select from public.notification_suppressions suppression where suppression.source_id=source.id)order by case when source.class in('mandate','payment_failure')then 0 when source.class='routine'then 2 else 1 end,source.created_at,source.id limit 500`;

interface NotificationContent {
  kind: 'decision' | 'mandate' | 'payment' | 'failure' | 'reply' | 'digest';
  title: string;
  why: string;
  target: Record<string, JsonValue>;
}
function contentFor(source: Source, p: NotificationSettings): NotificationContent {
  const data = source.data,
    log = { kind: 'system', view: 'log' },
    money = { kind: 'system', view: 'money' };
  if (source.source_table === 'decisions')
    return {
      kind: source.class === 'recommendation_changed' ? 'reply' : source.class === 'mandate' ? 'mandate' : 'decision',
      title: localized(
        p,
        source.class === 'recommendation_changed' ? 'A reply changed a recommendation' : 'A decision needs your review',
        source.class === 'recommendation_changed' ? 'غيّر ردٌ التوصية' : 'قرار يحتاج مراجعتك',
      ),
      why: clip(text(data, 'question'), 6000),
      target: { kind: 'decision', decisionId: text(data, 'decisionId') },
    };
  if (source.class === 'payment_executed' || source.class === 'payment_failure')
    return {
      kind: source.class === 'payment_executed' ? 'payment' : 'failure',
      title: localized(
        p,
        source.class === 'payment_executed'
          ? 'Payment confirmed'
          : data['state'] === 'ambiguous'
            ? 'Payment needs reconciliation'
            : 'Payment failed',
        source.class === 'payment_executed' ? 'تم تأكيد الدفع' : data['state'] === 'ambiguous' ? 'الدفع يحتاج مطابقة' : 'تعذّر الدفع',
      ),
      why: `${data['sandboxMode'] === true ? localized(p, 'Sandbox · ', 'بيئة اختبار · ') : ''}${text(data, 'payee')} · ${notificationMoney(text(data, 'amountMinor'), text(data, 'currency'), p.locale)} · ${text(data, 'purpose')} · ${localized(p, 'Mandate', 'التفويض')}: ${text(data, 'mandateId', localized(p, 'Specific approval', 'موافقة محددة'))}`,
      target: money,
    };
  if (source.source_table === 'effect_authorizations') {
    const ceiling = integer(data['ceilingMinor']),
      used = integer(data['usedMinor']),
      contacts = integer(data['contacts']),
      max = integer(data['maxContacts']),
      actions = integer(data['actions']),
      maxActions = integer(data['maxActions']),
      reached = (ceiling > 0n && used >= ceiling) || (max > 0n && contacts >= max) || (maxActions > 0n && actions >= maxActions);
    return {
      kind: 'mandate',
      title: localized(
        p,
        reached ? 'Mandate ceiling reached' : 'Mandate ceiling approaching',
        reached ? 'تم بلوغ سقف التفويض' : 'اقترب سقف التفويض',
      ),
      why: `${localized(p, 'Mandate', 'التفويض')} ${text(data, 'mandateId')} · ${localized(p, 'Reserved exposure', 'الالتزامات المحجوزة')}: ${notificationMoney(String(used), text(data, 'currency'), p.locale)} / ${notificationMoney(String(ceiling), text(data, 'currency'), p.locale)} · ${localized(p, 'New contacts', 'جهات الاتصال الجديدة')}: ${contacts}/${max}${maxActions > 0n ? ` · ${localized(p, 'Reserved actions', 'الإجراءات المحجوزة')}: ${actions}/${maxActions}` : ''}`,
      target: money,
    };
  }
  return {
    kind: 'failure',
    title: localized(p, 'Mission work needs attention', 'عمل المهمة يحتاج انتباهك'),
    why: clip(
      source.source_table === 'activity'
        ? text(data, 'summary')
        : localized(
            p,
            `A ${text(data, 'role', 'mission')} run failed. Open the activity log for the recorded failure.`,
            'تعذّر تنفيذ عمل في المهمة. افتح سجل النشاط للاطلاع على الخطأ المسجل.',
          ),
      6000,
    ),
    target: log,
  };
}
export interface NotificationReconciliation {
  channel: 'in_app';
  examined: number;
  released: number;
  suppressed: number;
  remaining: number;
  notificationIds: string[];
  nextDueAt: string | null;
}
/** Holds the mission lock through scheduling and in-app insertion. A crash rolls
 * back release+source links together; a retry cannot create a second notification.
 * No model, outbound email/SMS or external provider is called here. */
export async function reconcileNotifications(scope: ActorScope): Promise<NotificationReconciliation> {
  const mission = z.uuid().parse(scope.missionId);
  return withRole('lead_role', scope, async db => {
    await db.query('select public.lock_notification_reconcile($1)', [mission]);
    await db.query('select public.reconcile_decision_timing($1)', [mission]);
    const metadata = JsonObjectSchema.parse(
      (await db.query('select metadata from public.effective_missions where id=$1', [mission])).rows[0]?.metadata,
    );
    const preference = (
      await db.query(
        "select value from public.founder_preferences where mission_id=$1 and kind='notifications'order by created_at desc,id desc limit 1",
        [mission],
      )
    ).rows[0]?.value;
    const stored = preference === undefined ? {} : JsonObjectSchema.parse(preference);
    const settings = NotificationSettingsSchema.parse({
        timeZone: text(metadata, 'timeZone', 'UTC'),
        locale: text(metadata, 'locale', 'en').startsWith('ar') ? 'ar' : 'en',
        digestCadence: text(stored, 'digestCadence', 'daily'),
        digestHour: metadata['digestHour'] ?? 9,
        quietHours: stored['quietHours'] ?? null,
      }),
      hash = notificationConfigurationHash(settings),
      now = new Date();
    const sources = z.array(SourceSchema).parse((await db.query(sourceQuery, [mission])).rows),
      groups = new Map<string, { sources: Source[]; schedule: NotificationSchedule }>();
    let suppressed = 0;
    for (const source of sources) {
      if (
        source.data['inactive'] === true ||
        (source.class === 'payment_failure' && !['failed', 'ambiguous'].includes(text(source.data, 'currentState')))
      ) {
        await db.query('select public.suppress_notification($1,$2)', [mission, source.id]);
        suppressed++;
        continue;
      }
      if (source.source_table === 'decisions' && !text(source.data, 'momentId')) continue;
      const previous = source.schedule
        ? {
            configurationHash: source.schedule.configuration_hash,
            dueAt: source.schedule.due_at.toISOString(),
            delivery: source.schedule.delivery,
          }
        : undefined;
      const schedule = scheduleNotification(source.class, source.created_at, now, settings, previous);
      await db.query('select public.schedule_notification($1,$2,$3,$4,$5)', [mission, source.id, hash, schedule.dueAt, schedule.delivery]);
      if (Date.parse(schedule.dueAt) > now.getTime()) continue;
      const key =
        source.source_table === 'decisions'
          ? `moment:${text(source.data, 'momentId')}:${schedule.delivery}`
          : source.class === 'routine'
            ? 'digest'
            : source.source_table === 'effect_authorizations'
              ? `mandate:${text(source.data, 'mandateId')}`
              : source.id;
      const group = groups.get(key);
      if (group) group.sources.push(source);
      else groups.set(key, { sources: [source], schedule });
    }
    const notificationIds: string[] = [];
    let released = 0;
    for (const [key, group] of groups) {
      let content: NotificationContent;
      if (key === 'digest') {
        const examples = group.sources
          .filter(s => s.source_table === 'activity')
          .slice(0, 8)
          .map(s => clip(text(s.data, 'summary'), 400));
        const report: string[] = [];
        if (group.sources.some(s => s.source_table === 'money_ledger')) {
          const totals = (
            await db.query(
              'select currency,sandbox_mode,spent_minor::text,refund_minor::text,committed_minor::text,forecast_minor::text from public.money_totals where mission_id=$1 order by currency,sandbox_mode limit 20',
              [mission],
            )
          ).rows;
          for (const row of totals) {
            const t = JsonObjectSchema.parse(row),
              currency = text(t, 'currency');
            report.push(
              `${t['sandbox_mode'] === true ? localized(settings, 'Sandbox · ', 'بيئة اختبار · ') : ''}${localized(settings, 'Spent / refunded / committed / forecast', 'المصروف / المسترد / الملتزم / المتوقع')}: ${['spent_minor', 'refund_minor', 'committed_minor', 'forecast_minor'].map(k => notificationMoney(text(t, k), currency, settings.locale)).join(' / ')}`,
            );
          }
          const mandates = (
            await db.query(
              'select m.id,m.currency,greatest(0,m.ceiling_total-coalesce((select sum(a.amount_minor)from public.effect_authorizations a where a.mission_id=m.mission_id and a.mandate_id=m.id),0))::text remaining from public.mandates m where m.mission_id=$1 and m.expires_at>clock_timestamp()and not exists(select from public.mandate_revocations r where r.mandate_id=m.id)order by m.created_at,m.id limit 20',
              [mission],
            )
          ).rows;
          for (const row of mandates) {
            const m = JsonObjectSchema.parse(row);
            report.push(
              `${localized(settings, 'Remaining mandate authority', 'المتبقي من سقف التفويض')} ${text(m, 'id')}: ${notificationMoney(text(m, 'remaining'), text(m, 'currency'), settings.locale)}`,
            );
          }
        }
        content = {
          kind: 'digest',
          title: localized(settings, `${group.sources.length} mission updates`, `${group.sources.length} تحديثات في المهمة`),
          why: clip(
            [
              ...examples,
              ...report,
              localized(
                settings,
                'Open the activity and money ledgers for all source records.',
                'افتح سجلي النشاط والمال للاطلاع على جميع السجلات الأصلية.',
              ),
            ].join('\n'),
            11000,
          ),
          target: { kind: 'system', view: report.length ? 'money' : 'log' },
        };
      } else if (key.startsWith('moment:')) {
        // Every group is constructed with its first source and no sources are removed.
        const first = group.sources[0]!;
        content = {
          kind: group.sources.every(s => s.class === 'recommendation_changed') ? 'reply' : 'decision',
          title: localized(
            settings,
            group.sources.length === 1 ? 'A decision needs your review' : `${group.sources.length} decisions ready for review`,
            group.sources.length === 1 ? 'قرار يحتاج مراجعتك' : `${group.sources.length} قرارات جاهزة للمراجعة`,
          ),
          why: clip(group.sources.map(s => text(s.data, 'question')).join('\n'), 11000),
          target: { kind: 'decision', decisionId: text(first.data, 'decisionId') },
        };
        if (content.kind === 'reply') content.title = localized(settings, 'A reply changed a recommendation', 'غيّر ردٌ التوصية');
        // Groups are nonempty by construction above; the final source supplies the latest content.
      } else content = contentFor(group.sources[group.sources.length - 1]!, settings);
      const query = key.startsWith('moment:')
        ? 'select public.release_decision_notifications($1,$2,$3,$4,$5,$6,$7,$8)id'
        : 'select public.release_notification($1,$2,$3,$4,$5,$6,$7,$8)id';
      const id = z
        .uuid()
        .parse(
          (
            await db.query(query, [
              mission,
              group.sources.map(s => s.id),
              content.kind,
              clip(content.title, 500),
              clip(content.why, 12000),
              content.target,
              group.schedule.delivery,
              settings.locale,
            ])
          ).rows[0]?.id,
        );
      notificationIds.push(id);
      released += group.sources.length;
    }
    const pending = (
      await db.query(
        'select count(*)::text count,min(schedule.due_at)next from public.notification_sources source left join lateral(select due_at from public.notification_schedules s where s.source_id=source.id order by created_at desc,id desc limit 1)schedule on true where source.mission_id=$1 and not exists(select from public.notification_releases r where r.source_id=source.id)and not exists(select from public.notification_suppressions s where s.source_id=source.id)',
        [mission],
      )
    ).rows[0];
    return {
      channel: 'in_app',
      examined: sources.length,
      released,
      suppressed,
      remaining: z.coerce.number().int().safe().parse(pending?.count),
      notificationIds,
      nextDueAt: pending?.next ? z.coerce.date().parse(pending.next).toISOString() : null,
    };
  });
}
