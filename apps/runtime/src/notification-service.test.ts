import { describe, it, expect } from 'vitest';
import {
  notificationMoney,
  NotificationSettingsSchema,
  scheduleNotification,
  notificationConfigurationHash,
  type NotificationSettings,
} from './notification-service.js';
const settings: NotificationSettings = {
  timeZone: 'UTC',
  locale: 'en',
  digestCadence: 'daily',
  digestHour: 9,
  quietHours: { from: '22:30', to: '08:15' },
};
describe('FR-NOT-02/05 deterministic cadence and quiet-hour policy', () => {
  it('holds decisions at minute-accurate quiet boundaries and only mandate/payment failure break them', () => {
    const now = new Date('2026-11-12T22:31:00Z');
    for (const kind of ['decision', 'payment_executed', 'blocking_failure', 'recommendation_changed'] as const)
      expect(scheduleNotification(kind, now, now, settings)).toEqual({ delivery: 'after_quiet_hours', dueAt: '2026-11-13T08:15:00.000Z' });
    for (const kind of ['mandate', 'payment_failure'] as const)
      expect(scheduleNotification(kind, now, now, settings)).toEqual({ delivery: 'immediate', dueAt: now.toISOString() });
    expect(scheduleNotification('decision', new Date('2026-11-12T22:29:00Z'), new Date('2026-11-12T22:29:00Z'), settings).delivery).toBe(
      'immediate',
    );
  });
  it('schedules daily, Monday/Thursday and Monday digests after source time; routine never becomes immediate', () => {
    const created = new Date('2026-11-13T10:00:00Z');
    for (const cadence of ['daily', 'twice_weekly', 'weekly'] as const) {
      const s = { ...settings, digestCadence: cadence },
        result = scheduleNotification('routine', created, created, s);
      expect(result.delivery).toBe('digest');
      expect(result.dueAt).toBe(cadence === 'daily' ? '2026-11-14T09:00:00.000Z' : '2026-11-16T09:00:00.000Z');
    }
    expect(scheduleNotification('routine', new Date('2026-11-11T10:00:00Z'), new Date('2026-11-12T10:00:00Z'), settings).delivery).toBe(
      'digest',
    );
  });
  it('holds a digest whose due clock is quiet until the end of quiet hours', () => {
    const p = { ...settings, quietHours: { from: '21:00', to: '10:00' } },
      created = new Date('2026-11-12T12:00:00Z');
    expect(scheduleNotification('routine', created, created, p)).toEqual({ delivery: 'digest', dueAt: '2026-11-13T10:00:00.000Z' });
  });
  it('handles spring-forward nonexistent minutes and fall-back repeated quiet ends using actual timezone rules', () => {
    const p = { ...settings, timeZone: 'America/New_York', quietHours: { from: '22:00', to: '02:30' } },
      spring = new Date('2026-03-08T06:00:00Z');
    expect(scheduleNotification('decision', spring, spring, p).dueAt).toBe('2026-03-08T07:00:00.000Z');
    const fall = new Date('2026-11-01T06:15:00Z');
    expect(scheduleNotification('decision', fall, fall, { ...p, quietHours: { from: '22:00', to: '01:30' } }).dueAt).toBe(
      '2026-11-01T06:30:00.000Z',
    );
  });
  it('preserves a durable held schedule after the quiet period and recalculates changed cadence', () => {
    const created = new Date('2026-11-12T23:00:00Z'),
      held = scheduleNotification('decision', created, created, settings),
      previous = { ...held, configurationHash: notificationConfigurationHash(settings) };
    expect(scheduleNotification('decision', created, new Date('2026-11-13T10:00:00Z'), settings, previous)).toEqual(held);
    const routine = scheduleNotification('routine', created, created, settings);
    expect(
      scheduleNotification(
        'routine',
        created,
        created,
        { ...settings, digestCadence: 'weekly' },
        { ...routine, configurationHash: notificationConfigurationHash(settings) },
      ).dueAt,
    ).toBe('2026-11-16T09:00:00.000Z');
  });
  it('rejects invalid preferences and clocks rather than reporting a delivery', () => {
    expect(NotificationSettingsSchema.safeParse({ ...settings, timeZone: 'Unknown/Zone' }).success).toBe(false);
    expect(NotificationSettingsSchema.safeParse({ ...settings, quietHours: { from: '99:99', to: '08:00' } }).success).toBe(false);
    expect(() => scheduleNotification('decision', new Date('invalid'), new Date(), settings)).toThrow(/clock/);
  });
  it('formats integer minor amounts exactly and supports0/3-decimal currencies', () => {
    expect(notificationMoney('9007199254740991', 'SAR', 'en')).toBe('SAR 90,071,992,547,409.91');
    expect(notificationMoney('100', 'JPY', 'en')).toBe('JPY 100');
    expect(notificationMoney('12345', 'KWD', 'en')).toBe('KWD 12.345');
    expect(notificationMoney('12345', 'SAR', 'ar')).toContain('١٢٣');
  });
});
