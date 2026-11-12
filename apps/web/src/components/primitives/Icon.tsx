import type { IconName } from '../../ui-contract';

/** A 16px inline set at 1.5px stroke, drawn for the product (UX 9.7). No icon fonts, no emoji. */
const PATHS: Readonly<Record<IconName, string>> = {
  plus: 'M8 3.5v9M3.5 8h9',
  search: 'M7 3a4 4 0 1 1 0 8a4 4 0 0 1 0-8zM10 10l3 3',
  close: 'm4.5 4.5 7 7M11.5 4.5l-7 7',
  chev: 'm6.5 4 4 4-4 4',
  expand: 'M9.5 3.5h3v3M6.5 12.5h-3v-3M12.5 3.5 9 7M3.5 12.5 7 9',
  shrink: 'M12.5 6.5h-3v-3M3.5 9.5h3v3M9.5 6.5l3.5-3.5M6.5 9.5 3 13',
  mail: 'M4 4h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 12H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 4zM3 5l5 3.5L13 5',
  chat: 'M3 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 13 5v4.5A1.5 1.5 0 0 1 11.5 11H5.5z',
  phone: 'M5.5 2.5h-1a1.5 1.5 0 0 0-1.5 1.6 9.5 9.5 0 0 0 8.9 8.9 1.5 1.5 0 0 0 1.6-1.5v-1l-2.5-1-1.2 1.2a6 6 0 0 1-3-3L8 6.5z',
  check: 'm3.5 8.5 3 3 6-7',
  clock: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11zM8 5v3.2l2 1.3',
  doc: 'M4.5 2.5h5l2.5 2.5v8.5h-7.5zM9.5 2.5V5H12M6.5 8h3.5M6.5 10.5h3.5',
  coins:
    'M3.5 4.8c0-1 2-1.8 4.5-1.8s4.5.8 4.5 1.8-2 1.8-4.5 1.8-4.5-.8-4.5-1.8zM3.5 4.8v3.2c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4.8M3.5 8v3.2c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V8',
  shelf: 'M2.5 13.5h11M4.5 13.5V8.5h2.5v5M9 13.5V5.5h2.5v8',
  swatch: 'M3.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM7.5 5l3-2.5 3 3.5-6 6.5M7.5 13.5h5a1 1 0 0 0 1-1v-3',
  ladder: 'M3 13h10M4.5 13V9.5M8 13V6M11.5 13V3',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
  flag: 'M4 13.5V3M4 3.5h7l-1.5 2.5L11 8.5H4',
  retry: 'M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10',
  pen: 'm10.5 3 2.5 2.5-7 7H3.5V10z',
  enter: 'M12.5 3.5v4.5a1.5 1.5 0 0 1-1.5 1.5H4M6.5 7 4 9.5 6.5 12',
  box: 'M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5 8 7.5 13.5 5M8 7.5v6',
  arrow: 'M3 8h10M9.5 4.5 13 8l-3.5 3.5',
  undo: 'M5.5 4 2.5 7l3 3M2.5 7h7a4 4 0 0 1 0 8H8',
  moon: 'M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6z',
  globe: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11zM2.5 8h11M8 2.5c1.8 2 1.8 9 0 11M8 2.5c-1.8 2-1.8 9 0 11',
  ruler: 'M2.5 10.5 10.5 2.5l3 3-8 8zM5 8l1.5 1.5M7 6l1.5 1.5M9 4l1.5 1.5',
  minus: 'M3.5 8h9',
  fit: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
  pause: 'M8 2.5a5.5 5.5 0 1 1 0 11a5.5 5.5 0 0 1 0-11zM6.8 6v4M9.2 6v4',
  bell: 'M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9zM6.8 13.5a1.3 1.3 0 0 0 2.4 0',
  send: 'M8 13V3M3.5 7.5 8 3l4.5 4.5',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  lock: 'M4.5 7.5h7v6h-7zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  wifi: 'M2.5 6.5a8 8 0 0 1 11 0M4.5 8.8a5 5 0 0 1 7 0M6.6 11a2 2 0 0 1 2.8 0M3 3l10 10',
  kit: 'M3 5.5h10v7.5H3zM6 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M3 9h10',
  pin: 'M8 14s-4.5-4.2-4.5-7.5a4.5 4.5 0 0 1 9 0C12.5 9.8 8 14 8 14zM8 5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 0 1 0-3z',
  play: 'M5 3.5v9l7-4.5z',
};

/** Icons whose meaning has a direction (forward, back) mirror in RTL. */
const MIRRORED: ReadonlySet<IconName> = new Set<IconName>(['chev', 'arrow', 'enter', 'undo', 'retry']);

export function Icon({ name, className }: { readonly name: IconName; readonly className?: string }) {
  const cls = ['ico', MIRRORED.has(name) ? 'flipx' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
