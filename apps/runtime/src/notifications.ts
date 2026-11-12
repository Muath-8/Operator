export type NotificationClass =
  'decision' | 'mandate' | 'payment_executed' | 'payment_failure' | 'blocking_failure' | 'recommendation_changed' | 'routine';
export interface NotificationPreferences {
  timeZone: string;
  quietStartHour: number;
  quietEndHour: number;
  digestHour: number;
  locale: 'en' | 'ar';
}
export function notificationDelivery(
  kind: NotificationClass,
  now: Date,
  preferences: NotificationPreferences,
): 'immediate' | 'digest' | 'after_quiet_hours' {
  if (kind === 'mandate' || kind === 'payment_failure') return 'immediate';
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: preferences.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const { quietStartHour: start, quietEndHour: end } = preferences;
  const quiet = start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
  if (quiet) return 'after_quiet_hours';
  return kind === 'routine' ? 'digest' : 'immediate';
}
export function chaseAction(
  attempt: number,
  hasVerifiedAlternate: boolean,
  selected: boolean,
): 'same_channel' | 'alternate_channel' | 'inform_founder' | 'replacement_decision' | 'replace_candidate' {
  if (attempt < 1) return 'same_channel';
  if (attempt === 1 && hasVerifiedAlternate) return 'alternate_channel';
  if (attempt < 3) return 'inform_founder';
  return selected ? 'replacement_decision' : 'replace_candidate';
}
