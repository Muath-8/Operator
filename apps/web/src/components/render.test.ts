import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CommandResult, MissionCommands, MissionView, MissionWorkspaceProps, UiLanguage } from '../ui-contract';
import { MISSIONS, MISSIONS_WITH_NEW, newMission, perfumeMission, strapMission } from '../../tests/ui/fixtures/missions.fixture';
import { MissionWorkspace } from './MissionWorkspace';

/** Server-rendered structure checks. Visual, focus and axe checks run in the browser suite (tests/ui). */
const noop = async (): Promise<CommandResult> => ({ ok: true, ledgerVersion: 0 });
const commands = new Proxy({}, { get: () => noop }) as MissionCommands;
const render = (view: MissionView, language: UiLanguage = 'en', missions = MISSIONS) => {
  const props: MissionWorkspaceProps = {
    view,
    missions,
    connection: { status: 'live', lastSyncedAt: null },
    commands,
    host: { selectMission: () => undefined, setPreferences: () => undefined },
    theme: 'light',
    language,
  };
  return renderToString(createElement(MissionWorkspace, props));
};

interface Node {
  readonly tag: string;
  readonly attrs: string;
}
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Widgets. A focusable landmark region (the pannable canvas) is a container, not a control. */
const isControl = (n: Node) =>
  n.tag === 'button' ||
  (n.tag === 'a' && /\shref=/.test(n.attrs)) ||
  n.tag === 'input' ||
  n.tag === 'select' ||
  n.tag === 'textarea' ||
  (/\stabindex="0"/.test(n.attrs) && !/\srole="(region|dialog|group)"/.test(n.attrs)) ||
  /\srole="(button|radio|option|link|checkbox|tab|menuitem)"/.test(n.attrs);

/** Walk the markup, reporting any control nested inside another control. */
function nestedControls(html: string): string[] {
  const stack: Node[] = [];
  const out: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tagRaw, attrs = '', self] = m;
    const tag = (tagRaw ?? '').toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const node = { tag, attrs };
    if (isControl(node) && stack.some(isControl))
      out.push(
        `${stack
          .filter(isControl)
          .map(n => n.tag)
          .join('>')} > ${tag}${attrs.slice(0, 80)}`,
      );
    if (!self && !VOID.has(tag)) stack.push(node);
  }
  return out;
}

describe('MissionWorkspace server render', () => {
  const html = render(perfumeMission());

  it('renders the first screen: one sentence, one decision, one moment line', () => {
    expect(html).toContain('Three bottle quotes came in while you were away');
    expect(html).toContain('Which bottle route should we take?');
    expect(html).toContain('Approve stock bottle');
    expect(html).toContain('Decision moment: 3 decisions, about 6 minutes');
    expect((html.match(/class="dec[ "]/g) ?? []).length).toBe(1);
  });

  it('never nests a control inside another control (trust glyphs are described children)', () => {
    expect(nestedControls(html)).toEqual([]);
    expect(nestedControls(render(strapMission()))).toEqual([]);
    expect(nestedControls(render(newMission(), 'en', MISSIONS_WITH_NEW))).toEqual([]);
  });

  it('shows a trust glyph on every figure (I-14)', () => {
    const figures = [
      ...html.matchAll(
        /<span class="fig[^"]*" data-figure="[^"]+"[^>]*>([\s\S]*?)<\/span><\/span>|<span class="fig[^"]*" data-figure="[^"]+"[^>]*>([\s\S]*?class="tm[\s\S]*?)<\/span>/g,
      ),
    ];
    expect(figures.length).toBeGreaterThan(0);
    const bare = [...html.matchAll(/data-figure="([^"]+)"[^>]*>(?:(?!class="tm)[\s\S]){0,200}?<\/span><\/span>/g)].filter(
      m => !m[0].includes('class="tm'),
    );
    expect(bare).toEqual([]);
  });

  it('labels the strip, rail, working line and meters for assistive tech', () => {
    expect(html).toMatch(/<nav class="rail" aria-label="Missions"/);
    expect(html).toMatch(/class="working" role="status"/);
    // Label in name (WCAG 2.5.3): the meter's accessible name is computed from its content and
    // must start with the visible text. Compute it from the markup: drop SSR comment boundaries and tags.
    const meter = html.match(/<button[^>]*class="meter"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
    expect(meter).not.toMatch(/aria-label=/);
    const name = meter
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const visible = meter
      .replace(/<span class="sr">[\s\S]*?<\/span>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    expect(visible).toBe('Outreach 11/15');
    expect(name.startsWith(visible)).toBe(true);
    expect(name).toBe('Outreach 11/15 contacts, mandate active');
    expect(html).toMatch(/aria-current="page"/);
  });

  it('renders the second category with the same machinery and no special case', () => {
    const s = render(strapMission());
    expect(s).toContain('Which maker should make your first 50 straps?');
    expect(s).toContain('Approve Dabbagh Workshop');
    for (const cls of ['class="dec', 'class="opt sel"', 'class="embed', 'class="props"', 'class="strip"']) expect(s).toContain(cls);
  });

  it('renders Arabic chrome in RTL without changing the mission state', () => {
    const a = render(perfumeMission(), 'ar');
    expect(a).toContain('تأجيل');
    expect(a).toContain('لماذا؟');
    expect(a).toContain('Which bottle route should we take?');
    expect(a).toContain('lang="ar"');
  });

  it('shows the blank page with a question, a recommended answer and Skip', () => {
    const n = render(newMission(), 'en', MISSIONS_WITH_NEW);
    expect(n).toContain('Untitled mission');
    expect(n).toContain('Skip, use recommended');
    expect(n).toContain('Question 1 of 5');
  });

  it('separates sandbox and labels it everywhere (I-16)', () => {
    const v = perfumeMission();
    const s = render({ ...v, sandbox: true });
    expect(s).toContain('Sandbox mission: payments and messages go to test systems and never count as real spend.');
  });

  it('read-only access disables decisions and says why', () => {
    const v = perfumeMission();
    const s = render({
      ...v,
      access: { role: 'viewer', canDecide: false, canMessage: false, canGrantMandates: false, reason: 'You were invited to view.' },
    });
    expect(s).toContain('You can read this mission. You were invited to view.');
    expect(s).toMatch(/class="btn primary" aria-disabled="true"/);
  });
});
