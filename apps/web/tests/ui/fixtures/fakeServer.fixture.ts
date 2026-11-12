import type {
  ActivityStep,
  Block,
  ChangeRow,
  CommandBase,
  CommandError,
  CommandResult,
  DecisionView,
  HelpModeControl,
  ImpactView,
  MissionCommands,
  MissionView,
  OutcomeLevels,
  PageEntry,
  ReadinessLevel,
  RichText,
} from '../../../src/ui-contract';
import { newMission, perfumeMission, strapMission } from './missions.fixture';

/**
 * TEST FIXTURE ONLY: an in-memory stand-in for the server so the harness and UI tests can drive
 * the real components. It applies commands to a MissionView and pushes the new view after a lag,
 * the way Broadcast would. It is never a production simulator and never shipped.
 */
type Listener = (v: MissionView) => void;
const x = (text: string) => ({ t: 'text' as const, text });
const levelsOf = (v: MissionView): OutcomeLevels =>
  Object.fromEntries(v.readiness.outcomes.map(o => [o.outcome, o.level])) as unknown as OutcomeLevels;
const LEVEL = ['Unexplored', 'Explored', 'Concept approved', 'Specified', 'Verified', 'Launch-ready'];

interface Script {
  readonly reply: string;
  readonly ready?: Partial<Record<keyof OutcomeLevels, ReadinessLevel>>;
  readonly rows?: readonly [string, string, string][];
  readonly steps?: readonly { label: ActivityStep['label']; title: string; detail: string }[];
  readonly embed?: string;
  readonly working?: string;
  readonly produces?: readonly string[];
  readonly secondOrder?: readonly { label: string; via: string }[];
  readonly redo?: readonly string[];
  readonly cost?: string;
  readonly time?: string;
  readonly mandate?: string;
  readonly focusFrame?: { artifactId: string; frameId: string };
}

const SCRIPTS: Record<string, Script> = {
  'd-supplier:B': {
    reply: 'Done: Supplier B’s stock bottle. Spec is now v3, and Product and Supply both moved to Concept approved.',
    ready: { product: 2, supply: 2 },
    rows: [
      ['Forecast to launch', 'SAR 26,220', 'SAR 25,120'],
      ['Product spec', 'v2, stale', 'v3, for your approval'],
      ['Packaging', 'v2, stale', 'v3 for BR-50'],
    ],
    steps: [
      { label: 'running', title: 'Redrawing packaging for the BR-50 bottle', detail: 'Brand specialist; final artwork in about 3 days' },
      {
        label: 'planned',
        title: 'Ask Supplier B for a proforma invoice for 500 bottles',
        detail: 'Tomorrow, under the outreach mandate. It binds nothing until you accept it.',
      },
    ],
    embed: 'pack',
    working: 'redrawing packaging for BR-50',
    produces: ['Product spec v3', 'Packaging v3', 'Proforma request to Supplier B (planned)'],
    secondOrder: [{ label: 'Sample mandate', via: 'granted after this decision; its sample orders name BR-50' }],
    redo: ['Redraw packaging for the route you choose', 'Rewrite the product spec', 'Hold the proforma request to Supplier B'],
    cost: 'The forecast goes back up by SAR 1,100 until a route is chosen again.',
    time: 'About 3 days: spec and packaging are redrawn again.',
    focusFrame: { artifactId: 'pack', frameId: 'pack' },
  },
  'd-samples:grant': {
    reply:
      'Sample mandate granted: SAR 2,500 across up to 4 suppliers. I’ll order 3 samples of the chosen bottle and 3 closures, and file each receipt in Money.',
    rows: [['Samples mandate', 'requested', 'active, SAR 0 of 2,500 used']],
    mandate: 'smp',
  },
  'd-finish:matte': { reply: 'Recorded: matte. No cost change.', rows: [['Closure finish', 'open', 'matte']] },
  'd-maker:B': {
    reply:
      'Done: Dabbagh Workshop makes the first 50. The strap spec is now v2 at 22 mm, and Product and Supply moved to Concept approved.',
    ready: { product: 2, supply: 2 },
    rows: [
      ['Forecast to launch', 'SAR 12,500', 'SAR 10,100'],
      ['Strap spec', 'v1, 20 mm', 'v2, 22 mm'],
    ],
    steps: [
      { label: 'running', title: 'Redrawing the strap spec for 22 mm', detail: 'Product specialist' },
      { label: 'planned', title: 'Ask Dabbagh Workshop for one sample strap', detail: 'Under the outreach mandate' },
    ],
    embed: 'spec',
    working: 'drafting strap spec v2 for 22 mm',
    produces: ['Strap spec v2', 'Sample request to Dabbagh Workshop (planned)'],
    redo: ['Rewrite the strap spec', 'Hold the sample request'],
    cost: 'The forecast goes back up by SAR 2,400.',
    time: 'About 1 day: the spec is redrawn.',
  },
};

export interface FakeOptions {
  readonly latencyMs?: number;
  readonly lagMs?: number;
}

export class FakeMissionServer {
  private views = new Map<string, MissionView>();
  private listeners = new Set<Listener>();
  private failures: CommandError[] = [];
  private seen = new Map<string, CommandResult>();
  private seq = 1000;
  private privacyByMission = new Map<
    string,
    {
      traceRetentionEnabled: boolean;
      externalTraceExportConfigured: boolean;
      retentionDays: 90;
      objects: {
        id: string;
        kind: 'recording';
        sourceReference: string;
        createdAt: string;
        expiresAt: string;
        kept: boolean;
        available: boolean;
      }[];
    }
  >();
  privacy(missionId: string) {
    this.view(missionId);
    let value = this.privacyByMission.get(missionId);
    if (!value) {
      value = {
        traceRetentionEnabled: true,
        externalTraceExportConfigured: false,
        retentionDays: 90,
        objects: [
          {
            id: '91111111-1111-4111-8111-111111111111',
            kind: 'recording',
            sourceReference: 'fixture-recording',
            createdAt: '2026-11-12T09:00:00Z',
            expiresAt: '2027-02-10T09:00:00Z',
            kept: false,
            available: true,
          },
        ],
      };
      this.privacyByMission.set(missionId, value);
    }
    return structuredClone(value);
  }
  readonly calls: { name: string; input: unknown }[] = [];
  constructor(private readonly opts: FakeOptions = {}) {
    for (const v of [perfumeMission(), strapMission(), newMission()]) this.views.set(v.missionId, v);
  }

  view(id: string): MissionView {
    const v = this.views.get(id);
    if (!v) throw new Error(`no mission ${id}`);
    return v;
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** The next command fails with this error (failure injection). */
  failNext(error: CommandError) {
    this.failures.push(error);
  }
  setView(v: MissionView) {
    this.views.set(v.missionId, v);
    this.listeners.forEach(l => l(v));
  }

  private wait(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
  private id(p: string) {
    this.seq += 1;
    return `${p}${this.seq}`;
  }
  private now() {
    return new Date('2026-11-12T09:41:00+03:00').toISOString();
  }

  /** Apply a mutation; respond after latency; push the view after lag (ledger catches up later). */
  private async exec(
    name: string,
    base: CommandBase | { idempotencyKey: string },
    mutate: (v: MissionView) => MissionView | { view: MissionView; result: Partial<Extract<CommandResult, { ok: true }>> },
  ): Promise<CommandResult> {
    this.calls.push({ name, input: base });
    const replay = this.seen.get(base.idempotencyKey);
    await this.wait(this.opts.latencyMs ?? 350);
    if (replay) return replay; // same key: never a second effect (I-4)
    const fail = this.failures.shift();
    if (fail) return { ok: false, error: fail };
    const missionId = 'missionId' in base ? base.missionId : 'm1';
    const cur = this.view(missionId);
    const out = mutate(structuredClone(cur));
    const next = 'view' in out ? out.view : out;
    const extra = 'view' in out ? out.result : {};
    const version = cur.ledgerVersion + 1;
    const pushed = { ...next, ledgerVersion: version };
    this.views.set(missionId, pushed);
    const result: CommandResult = { ok: true, ledgerVersion: version, ...extra };
    this.seen.set(base.idempotencyKey, result);
    setTimeout(() => this.listeners.forEach(l => l(pushed)), this.opts.lagMs ?? 300);
    return result;
  }

  private agent(v: MissionView, blocks: Block[], streaming = false): PageEntry {
    const e: PageEntry = { id: this.id('e'), author: 'agent', at: this.now(), streaming, staleNote: null, blocks };
    (v.entries as PageEntry[]).push(e);
    return e;
  }
  private step(v: MissionView, label: ActivityStep['label'], title: string, detail: string, help?: HelpModeControl): string {
    const id = this.id('st');
    (v.activity as Record<string, ActivityStep>)[id] = {
      id,
      label,
      title: [x(title)],
      details: [[x(detail)]],
      at: this.now(),
      ...(help ? { help } : {}),
    };
    (v.activityOrder as string[]).unshift(id);
    return id;
  }
  private setLevels(v: MissionView, ready: Partial<Record<string, ReadinessLevel>>) {
    (v.readiness as { outcomes: MissionView['readiness']['outcomes'] }).outcomes = v.readiness.outcomes.map(o =>
      ready[o.outcome] !== undefined ? { ...o, level: ready[o.outcome] as ReadinessLevel } : o,
    );
  }

  readonly commands: MissionCommands = {
    resolveDecision: input =>
      this.exec('resolveDecision', input, v => {
        const d = v.decisions[input.decisionId] as DecisionView | undefined;
        if (!d || d.status !== 'pending') return v;
        const o = d.options.find(z => z.id === input.optionId);
        const s = SCRIPTS[`${input.decisionId.split('~')[0]}:${input.optionId}`] ?? {
          reply: `Recorded: ${o?.shortLabel ?? input.optionId}.`,
        };
        const from = levelsOf(v);
        Object.assign(d, {
          status: 'approved',
          resolution: { optionId: input.optionId, how: 'founder', at: this.now() },
          canChange: !!s.produces,
        });
        if (s.ready) this.setLevels(v, s.ready);
        if (s.mandate)
          v.money.mandates.forEach(
            m =>
              m.id === s.mandate &&
              Object.assign(m, {
                status: 'active',
                ...(input.mandateScope
                  ? { usage: { kind: 'money', used: { amountMinor: 0, currency: 'SAR' }, ceiling: input.mandateScope.ceiling } }
                  : {}),
              }),
          );
        if (s.working) Object.assign(v, { working: { state: 'working', text: s.working } });
        const to = levelsOf(v);
        const moved = (Object.keys(to) as (keyof OutcomeLevels)[]).filter(k => to[k] !== from[k]);
        const rows: ChangeRow[] = [
          ...moved.map(k => ({
            id: this.id('r'),
            label: k[0]?.toUpperCase() + k.slice(1),
            from: `R${from[k]} ${LEVEL[from[k]]}`,
            to: `R${to[k]} ${LEVEL[to[k]]}`,
            direction: to[k] > from[k] ? ('up' as const) : ('down' as const),
          })),
          ...(s.rows ?? []).map(([label, f, t]) => ({ id: this.id('r'), label, from: f, to: t, direction: 'neutral' as const })),
        ];
        const stepIds = (s.steps ?? []).map(st => this.step(v, st.label, st.title, st.detail));
        const left = (v.moment?.decisionIds ?? []).filter(id => v.decisions[id]?.status === 'pending');
        const blocks: Block[] = [{ k: 'prose', paragraphs: [[x(s.reply)]] }];
        if (rows.length) blocks.push({ k: 'changes', rows });
        if (moved.length) blocks.push({ k: 'readiness', from, to, blockersFor: moved });
        if (stepIds.length) blocks.push({ k: 'steps', stepIds });
        if (s.embed) blocks.push({ k: 'embed', artifactId: s.embed });
        if (left.length)
          blocks.push({
            k: 'prose',
            paragraphs: [
              [
                x(
                  `${left.length === 1 ? 'One more decision' : 'Two more decisions'} in this moment: ${left.map(id => v.decisions[id]?.topic).join(' and ')}. `,
                ),
                { t: 'link', text: 'Take them now', target: { kind: 'decision', decisionId: left[0] ?? '' } },
                x(`, about ${left.length * 2} minutes.`),
              ],
            ],
          });
        this.agent(v, blocks);
        (v.decisionRecord as MissionView['decisionRecord'][number][]).unshift({
          id: this.id('rec'),
          decisionId: d.id,
          at: this.now(),
          status: 'approved',
          text: o ? o.label.map(r => ('text' in r ? r.text : '')).join('') : d.question,
          canChange: !!s.produces,
        });
        if (s.focusFrame) Object.assign(v, { focus: { target: { kind: 'artifact', ...s.focusFrame }, reason: 'What changed' } });
        if (s.steps?.some(st => st.label === 'running')) {
          setTimeout(() => {
            const cur = structuredClone(this.view(v.missionId));
            for (const id of stepIds) {
              const st = (cur.activity as Record<string, ActivityStep>)[id];
              if (st && st.label === 'running')
                Object.assign(st, {
                  label: 'performed',
                  title: [
                    x(
                      st.title
                        .map(r => ('text' in r ? r.text : ''))
                        .join('')
                        .replace(/^Redrawing/, 'Drew'),
                    ),
                  ],
                });
            }
            this.setView({ ...cur, ledgerVersion: cur.ledgerVersion + 1 });
          }, 2400);
        }
        return v;
      }),
    deferDecision: input =>
      this.exec('deferDecision', input, v => {
        const d = v.decisions[input.decisionId];
        if (d) Object.assign(d, { status: 'deferred' });
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [
                x(
                  `Deferred. ${d?.blocks ?? 'Nothing else waits on it.'} Everything else keeps moving, and I’ll bring it back in the next decision moment.`,
                ),
              ],
            ],
          },
        ]);
        return v;
      }),
    requestChange: input =>
      this.exec('requestChange', input, v => {
        const decisionId = 'decisionId' in input ? input.decisionId : null;
        const d = decisionId ? v.decisions[decisionId] : null;
        const s = d ? SCRIPTS[`${d.id.split('~')[0]}:${d.resolution?.optionId ?? ''}`] : undefined;
        const impactId = this.id('imp');
        const impact: ImpactView = {
          id: impactId,
          decisionId,
          title: d ? `Change the ${d.topic}?` : 'Return to this direction?',
          stale: s?.produces ?? ['Logo set', 'Packaging v2', 'Store draft', 'Editable asset package'],
          secondOrder: s?.secondOrder ?? [],
          readiness: s?.ready
            ? (Object.entries(s.ready) as [keyof OutcomeLevels, ReadinessLevel][]).map(([o, l]) => ({
                outcome: o,
                from: l,
                to: Math.max(0, l - 1) as ReadinessLevel,
              }))
            : [{ outcome: 'brand', from: 3, to: 2 }],
          cost: s?.cost ?? 'None: inside the brand envelope.',
          time: s?.time ?? 'About 2 days for the logo set and packaging.',
          redo: [...(s?.redo ?? ['Recolour the logo set', 'Redraw packaging in the new palette', 'Update the store draft'])],
          confirmLabel: d ? 'Reopen the decision' : 'Return to this direction',
          status: 'open',
        };
        (v.impacts as Record<string, ImpactView>)[impactId] = impact;
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [
                x(
                  d
                    ? `Changing the ${d.topic} reopens a decision you approved, so here is what it touches first. Nothing changes until you confirm.`
                    : 'Going back supersedes the decision of 29 Oct. Here is what it touches first.',
                ),
              ],
            ],
          },
          { k: 'impact', impactId },
        ]);
        return v;
      }),
    confirmChange: input =>
      this.exec('confirmChange', input, v => {
        const imp = v.impacts[input.impactId];
        if (!imp) return v;
        Object.assign(imp, { status: 'confirmed' });
        const d = imp.decisionId ? v.decisions[imp.decisionId] : null;
        if (!d) return v;
        const nid = `${d.id.split('~')[0]}~${this.seq + 1}`;
        const from = levelsOf(v);
        const ready: Record<string, ReadinessLevel> = {};
        for (const r of imp.readiness) ready[r.outcome] = r.to;
        this.setLevels(v, ready);
        const to = levelsOf(v);
        (v.decisions as Record<string, DecisionView>)[nid] = {
          ...structuredClone(d),
          id: nid,
          status: 'pending',
          resolution: null,
          supersedesId: d.id,
          supersededById: null,
          canChange: false,
        };
        Object.assign(d, { status: 'superseded', supersededById: nid, canChange: false });
        if (v.moment) Object.assign(v.moment, { decisionIds: v.moment.decisionIds.map(id => (id === d.id ? nid : id)) });
        v.entries.forEach(e => {
          if (
            e.blocks.some(b => b.k === 'changes') &&
            e.blocks.some(b => b.k === 'prose' && JSON.stringify(b).includes(d.topic.split(' ')[0] ?? '§'))
          )
            Object.assign(e, { staleNote: `Superseded today: the ${d.topic} was reopened. What this entry produced is now stale.` });
        });
        v.decisionRecord.forEach(r => r.decisionId === d.id && Object.assign(r, { status: 'superseded', canChange: false }));
        const stepIds = imp.redo.map(t => this.step(v, 'planned', t, 'Waits on your new choice'));
        const moved = (Object.keys(to) as (keyof OutcomeLevels)[]).filter(k => to[k] !== from[k]);
        Object.assign(v, { working: { state: 'waiting', text: `waiting on the reopened ${d.topic}` } });
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [
                x(
                  'Reopened. The old choice stays in the record, marked superseded, with a link to this one. Here is what I’ll redo once you choose again:',
                ),
              ],
            ],
          },
          { k: 'steps', stepIds },
          ...(moved.length ? [{ k: 'readiness' as const, from, to, blockersFor: moved }] : []),
          { k: 'decision', decisionId: nid },
        ]);
        return v;
      }),
    keepDecision: input =>
      this.exec('keepDecision', input, v => {
        const imp = v.impacts[input.impactId];
        if (imp) Object.assign(imp, { status: 'kept' });
        return v;
      }),
    justGo: input =>
      this.exec('justGo', input, v => {
        const applied: string[] = [];
        for (const d of Object.values(v.decisions)) {
          if (d.status === 'pending' && !d.binding) {
            Object.assign(d, { status: 'approved', resolution: { optionId: d.recommendedOptionId, how: 'default', at: this.now() } });
            applied.push(d.topic);
          }
        }
        const still = Object.values(v.decisions).filter(d => d.status === 'pending');
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [
                x(
                  `Going ahead on defaults. ${applied.length ? `Applied: ${applied.join(', ')}.` : 'Nothing left had a default.'}${still.length ? ` ${still.length === 1 ? 'One still needs' : 'Two still need'} you, because they spend money or bind you: ${still.map(d => d.topic).join(' and ')}.` : ''}`,
                ),
              ],
            ],
          },
        ]);
        return v;
      }),
    completeMoment: input =>
      this.exec('completeMoment', input, v => {
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [x(`That’s the moment done: ${input.resolvedDecisionIds.length} decisions. Here is what changed, and what I do next.`)],
            ],
          },
          {
            k: 'changes',
            title: 'What changed in this moment',
            rows: input.resolvedDecisionIds.map(id => ({
              id: this.id('r'),
              label: v.decisions[id]?.topic ?? id,
              from: 'open',
              to: v.decisions[id]?.status ?? 'recorded',
              direction: 'neutral' as const,
            })),
          },
        ]);
        return v;
      }),
    sendMessage: input =>
      this.exec('sendMessage', input, v => {
        (v.entries as PageEntry[]).push({
          id: this.id('y'),
          author: 'founder',
          at: this.now(),
          streaming: false,
          staleNote: null,
          blocks: [],
          text: input.text,
          delivery: 'sent',
        });
        const q = input.text.toLowerCase();
        let reply: Block[];
        if (/waiting/.test(q))
          reply = [
            { k: 'prose', paragraphs: [[x('I’m waiting on two things.')]] },
            {
              k: 'steps',
              stepIds: [
                this.step(v, 'failed', 'Supplier C: revised quote', '2 days overdue (due 10 Nov).'),
                this.step(v, 'planned', 'Al-Wadi studio: three fragrance samples', 'Due 21 Nov.'),
              ],
            },
          ];
        else if (/cost|spent|money/.test(q))
          reply = [{ k: 'prose', paragraphs: [[x('SAR 1,180 so far, each with a receipt. Nothing is committed.')]] }, { k: 'money' }];
        else if (/need from me/.test(q))
          reply = [
            {
              k: 'prose',
              paragraphs: [[x('Three decisions, batched in today’s decision moment: bottle route, sample mandate, closure finish.')]],
            },
            { k: 'moment' },
          ];
        else
          reply = [
            {
              k: 'prose',
              paragraphs: [
                [
                  x(
                    'I don’t have a precise answer to that in the mission record, and I’d rather not guess. These I can always answer exactly:',
                  ),
                ],
              ],
            },
            { k: 'suggestions', items: v.suggestions },
          ];
        this.agent(v, reply);
        return v;
      }),
    answerQuestion: input =>
      this.exec('answerQuestion', input, v => {
        const q = v.questions[input.questionId];
        if (q) Object.assign(q, { status: input.skipped ? 'skipped' : 'answered', answer: input.answer });
        return v;
      }),
    setHelpMode: input =>
      this.exec('setHelpMode', input, v => {
        const patch = (c: HelpModeControl | null | undefined) => {
          if (c && c.targetId === input.control.targetId) Object.assign(c, { mode: input.mode });
        };
        Object.values(v.activity).forEach(a => patch(a.help));
        v.commitments.forEach(c => patch(c.help));
        let sent = false;
        for (const a of Object.values(v.artifacts)) {
          if (a.content.kind === 'thread') {
            patch(a.content.help);
            if (a.content.help.targetId === input.control.targetId && input.mode === 'do' && a.content.draft) {
              this.sendDraft(v, a.id);
              sent = true;
            }
          }
        }
        const name = { guide: 'Guide me', do: 'Do it for me', help: 'Help me do it' }[input.mode];
        this.agent(v, [
          {
            k: 'prose',
            paragraphs: [
              [
                x(
                  sent
                    ? 'Switched to Do it for me: the held draft went out under the outreach mandate. Approvals that spend money or bind you are unaffected.'
                    : `Now on “${name}”. Approvals that spend money or bind you are unaffected.`,
                ),
              ],
            ],
          },
        ]);
        return v;
      }),
    approveDraft: input =>
      this.exec('approveDraft', input, v => {
        this.sendDraft(v, input.artifactId);
        this.agent(v, [
          { k: 'prose', paragraphs: [[x('Sent to Supplier B. It commits you to nothing. Their reply will be filed on the thread.')]] },
        ]);
        return v;
      }),
    discardDraft: input =>
      this.exec('discardDraft', input, v => {
        const a = v.artifacts[input.artifactId];
        if (a && a.content.kind === 'thread') Object.assign(a.content, { draft: null });
        this.agent(v, [{ k: 'prose', paragraphs: [[x('Draft discarded. Nothing was sent.')]] }]);
        return v;
      }),
    retryStep: input =>
      this.exec('retryStep', input, v => {
        const st = (v.activity as Record<string, ActivityStep>)[input.stepId];
        if (st) Object.assign(st, { label: 'retrying', retry: null, details: [[x('Sending by marketplace message…')]] });
        setTimeout(() => {
          const cur = structuredClone(this.view(v.missionId));
          const s2 = (cur.activity as Record<string, ActivityStep>)[input.stepId];
          if (s2)
            Object.assign(s2, {
              label: 'performed',
              title: [x('Follow-up to Supplier D resent by marketplace message')],
              details: [[x('Sent now, message mk-2207, under the outreach mandate')]],
            });
          this.setView({ ...cur, ledgerVersion: cur.ledgerVersion + 1 });
        }, 1400);
        return v;
      }),
    requestVariation: input =>
      this.exec('requestVariation', input, v => {
        const a = v.artifacts[input.artifactId];
        const f = a && a.content.kind === 'canvas' ? a.content.frames.find(z => z.id === input.frameId) : null;
        if (f && f.body.k === 'identity')
          Object.assign(f.body, { generating: { label: `Generating v${f.inspector.versions.length + 1}` } });
        Object.assign(v, { working: { state: 'working', text: `generating ${f?.title ?? 'a variation'}` } });
        this.agent(v, [
          {
            k: 'steps',
            stepIds: [
              this.step(
                v,
                'running',
                `Generating a warmer ${f?.title ?? 'direction'}`,
                'Brand specialist: shifting the palette toward amber',
              ),
            ],
          },
        ]);
        return v;
      }),
    runArtifactAction: input => this.commands.requestChange({ ...input, versionId: input.versionId ?? '', actionId: input.actionId }),
    setMandateStatus: input =>
      this.exec('setMandateStatus', input, v => {
        v.money.mandates.forEach(
          m =>
            m.id === input.mandateId &&
            Object.assign(m, { status: 'revoked', revokedNote: 'Revoked today. I cancelled two queued follow-ups.' }),
        );
        this.agent(v, [
          { k: 'prose', paragraphs: [[x('Mandate revoked. I stopped before the next action and cancelled two queued follow-ups.')]] },
        ]);
        return v;
      }),
    setMissionStatus: input =>
      this.exec('setMissionStatus', input, v => {
        Object.assign(v, {
          status: input.status,
          working: input.status === 'paused' ? { state: 'paused', text: '' } : { state: 'working', text: 'resuming' },
        });
        return v;
      }),
    // This older scenario fixture has no retained payloads or privacy state.
    setTraceRetention: input =>
      this.exec('setTraceRetention', input, v => {
        this.privacyByMission.set(v.missionId, { ...this.privacy(v.missionId), traceRetentionEnabled: input.enabled });
        return v;
      }),
    keepRetainedContent: input =>
      this.exec('keepRetainedContent', input, v => {
        const privacy = this.privacy(v.missionId);
        this.privacyByMission.set(v.missionId, {
          ...privacy,
          objects: privacy.objects.map(object => (object.id === input.objectId ? { ...object, kept: input.keep } : object)),
        });
        return v;
      }),
    markNotificationsRead: input =>
      this.exec('markNotificationsRead', input, v => {
        v.notifications.forEach(n => input.notificationIds.includes(n.id) && Object.assign(n, { read: true }));
        return v;
      }),
    updateNotificationSettings: input =>
      this.exec('updateNotificationSettings', input, v => ({ ...v, notificationSettings: input.settings })),
    exportLaunchRecord: input =>
      this.exec('exportLaunchRecord', input, v => ({
        view: v,
        result: { downloadUrl: `data:text/plain,Launch%20Record%20${input.format}` },
      })),
    createMission: input => this.exec('createMission', input, v => ({ view: v, result: { missionId: 'm3' } })),
  };

  private sendDraft(v: MissionView, artifactId: string) {
    const a = v.artifacts[artifactId];
    if (!a || a.content.kind !== 'thread' || !a.content.draft) return;
    const d = a.content.draft;
    const out = v.money.mandates.find(m => m.id === 'out');
    if (out?.usage?.kind === 'count') Object.assign(out.usage, { used: out.usage.used + 1 });
    const used = out?.usage?.kind === 'count' ? out.usage.used : 0;
    (a.content.messages as unknown[]).push({
      id: this.id('msg-'),
      direction: 'outbound',
      channel: d.channel,
      at: this.now(),
      author: 'Mission Lead',
      original: d.original,
      ...(d.translation ? { translation: d.translation } : {}),
      authority: {
        label: `Sent under the outreach mandate (${used} of 15)`,
        evidence: {
          id: this.id('au'),
          trust: 'performed',
          text: 'Mailbox log',
          source: { label: 'Project mailbox' },
          observedAt: this.now(),
        },
      },
      delivery: 'sent',
    });
    Object.assign(a.content, { draft: null });
  }
}

export const paragraphs = (...p: string[]): RichText[] => p.map(s => [x(s)]);
