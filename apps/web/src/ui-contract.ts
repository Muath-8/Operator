/**
 * Launch Operator UI contract.
 *
 * The workspace renders a serializable projection of the Mission State (MissionView)
 * and reports founder intent through typed async commands (MissionCommands).
 *
 * Rules this contract encodes (UX 8.3, Quality Bar 8, I-14, I-15, I-16):
 * - The UI never invents binding state. Decisions, money, mandates and readiness change
 *   only when a new MissionView arrives whose ledgerVersion covers the command result.
 * - Every figure carries trust, source and date (Figure requires them by type).
 * - Money is integer minor units plus an ISO 4217 currency code.
 * - Nothing here names a product category; category vocabulary arrives as data.
 * - Everything is JSON-serializable: no functions, Dates, Maps or class instances in views.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** ISO 8601 timestamp, e.g. "2026-11-12T09:41:00+03:00". */
export type IsoDateTime = string;
/** ISO 8601 calendar date, e.g. "2026-11-15". */
export type IsoDate = string;
/** BCP 47 language tag of a piece of content, e.g. "ar", "en". */
export type ContentLang = string;
/** Interface languages the chrome is translated into. */
export type UiLanguage = 'en' | 'ar';
export type Theme = 'light' | 'dark';

/** Money in integer minor units (halalas for SAR, cents for USD). */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Trust levels shared with the Mission State evidence ledger, plus `failed` for failed effects. */
export type TrustLevel = 'planned' | 'performed' | 'claimed' | 'verified' | 'founder_confirmed';
export type GlyphTrust = TrustLevel | 'failed';

export type Outcome = 'brand' | 'product' | 'supply' | 'commerce' | 'compliance' | 'demand';
export const OUTCOMES: readonly Outcome[] = ['brand', 'product', 'supply', 'commerce', 'compliance', 'demand'];
/** R0 to R5. */
export type ReadinessLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type OutcomeLevels = Readonly<Record<Outcome, ReadinessLevel>>;

export type HelpMode = 'guide' | 'do' | 'help';

/** Where a piece of evidence came from. */
export interface SourceRef {
  /** Human label, e.g. "Supplier B, WhatsApp message". */
  readonly label: string;
  /** Opaque reference (message id, receipt id, URL). Shown, never executed. */
  readonly reference?: string;
  readonly url?: string;
}

/** A value the founder sees. Every figure carries its trust and source (I-14). */
export type FigureValue =
  | { readonly kind: 'money'; readonly amount: Money; readonly per?: string }
  | { readonly kind: 'quantity'; readonly value: number; readonly unit: string }
  | { readonly kind: 'duration'; readonly days: number }
  | { readonly kind: 'percent'; readonly value: number }
  | { readonly kind: 'date'; readonly date: IsoDate }
  | { readonly kind: 'text'; readonly text: string };

export interface Figure {
  readonly id: string;
  readonly value: FigureValue;
  readonly trust: GlyphTrust;
  readonly source: SourceRef;
  /** When the figure was observed or recorded. */
  readonly observedAt: IsoDateTime;
  /** Optional extra line in the tooltip, e.g. "converted at 3.75". */
  readonly note?: string;
  /** Original value before normalisation, e.g. "USD 2.61". */
  readonly original?: string;
}

/** A trust-marked evidence line, e.g. in readiness rungs or the inspector. */
export interface EvidenceItem {
  readonly id: string;
  readonly trust: GlyphTrust;
  readonly text: string;
  readonly source: SourceRef;
  readonly observedAt: IsoDateTime;
  readonly sandbox?: boolean;
}

/** Glossary entry for business terms (FR-EASE-12). */
export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
  /** First use in this mission: explain inline as well as in the tooltip. */
  readonly firstUse?: boolean;
}

/* ------------------------------------------------------------------ */
/* Rich text: serializable inline content (no HTML from the server)    */
/* ------------------------------------------------------------------ */

export type Target =
  | { readonly kind: 'artifact'; readonly artifactId: string; readonly frameId?: string; readonly versionId?: string }
  | { readonly kind: 'decision'; readonly decisionId: string }
  | { readonly kind: 'entry'; readonly entryId: string }
  | { readonly kind: 'system'; readonly view: SystemPeek }
  | { readonly kind: 'readiness'; readonly outcome: Outcome; readonly level?: ReadinessLevel };

export type SystemPeek = 'readiness' | 'money' | 'log' | 'notifications' | 'plates' | 'record' | 'accounts';

export type Inline =
  | { readonly t: 'text'; readonly text: string; readonly emphasis?: 'strong' | 'struck' }
  | { readonly t: 'figure'; readonly figure: Figure }
  | { readonly t: 'term'; readonly text: string; readonly termId: string }
  | { readonly t: 'link'; readonly text: string; readonly target: Target }
  /** A suggested founder message; activating it sends the text through the composer path. */
  | { readonly t: 'ask'; readonly text: string; readonly message: string }
  | { readonly t: 'correction'; readonly from: string; readonly to: string };

/** A paragraph of inline runs. Paragraph breaks are separate RichText entries in arrays. */
export type RichText = readonly Inline[];

/* ------------------------------------------------------------------ */
/* Technical plates: products drawn from a spec, never by category     */
/* ------------------------------------------------------------------ */

/** Material names map to theme tokens; they are not colours. */
export type PlateMaterial = 'glass' | 'solid' | 'metal' | 'leather' | 'wax' | 'wood' | 'ghost' | 'void' | 'hint' | 'paper';

export type PlatePart =
  | {
      readonly t: 'rect';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly r?: number;
      readonly m?: PlateMaterial;
      readonly role?: string;
      readonly finish?: boolean;
      readonly note?: string;
    }
  | { readonly t: 'poly'; readonly pts: readonly (readonly [number, number])[]; readonly m?: PlateMaterial; readonly role?: string }
  | {
      readonly t: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly m?: PlateMaterial;
      readonly role?: string;
    }
  | { readonly t: 'holes'; readonly x: number; readonly y0: number; readonly n: number; readonly step: number; readonly r: number }
  | {
      readonly t: 'line';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly m?: 'hint' | 'solid';
    }
  | { readonly t: 'mark'; readonly cx: number; readonly cy: number; readonly size: number; readonly role?: string }
  | {
      readonly t: 'text';
      readonly x: number;
      readonly y: number;
      readonly s: string;
      readonly size: number;
      readonly role?: string;
      readonly track?: number;
      readonly lang?: ContentLang;
    };

/** Millimetres; origin at bottom centre; y up. */
export interface PlateSpec {
  readonly kind: string;
  readonly code?: string;
  readonly dims_mm: { readonly w: number; readonly h: number; readonly d?: number };
  readonly parts: readonly PlatePart[];
}

/** A vector mark drawn from paths. Colours are palette indices, so marks follow the palette. */
export interface MarkGlyph {
  readonly viewBox: string;
  readonly paths: readonly {
    readonly d: string;
    /** Index into the palette, or 'current' for currentColor. */
    readonly stroke?: number | 'current';
    readonly fill?: number | 'current';
    readonly width?: number;
  }[];
}

/** Brand palette tint for plate parts, by part role. Values are palette indices. */
export interface PlateTint {
  readonly palette: readonly string[];
  readonly byRole: Readonly<Record<string, number>>;
  /** Palette index used for strokes on tinted parts (the brand's darkest colour). */
  readonly stroke?: number;
  readonly mark?: MarkGlyph;
}

export type PlateFinish = 'matte' | 'gloss';

/** One drawing plus how it is presented. */
export interface PlateExhibit {
  readonly spec: PlateSpec;
  readonly tint?: PlateTint;
  readonly finish?: PlateFinish;
  /** Text alternative: dims, price, MOQ (UX 10, Plate). */
  readonly summary: string;
}

/* ------------------------------------------------------------------ */
/* Artifacts                                                           */
/* ------------------------------------------------------------------ */

/** The renderer is chosen by type: comparison and visual mount the canvas; document and thread mount documents. */
export type ArtifactType = 'comparison' | 'visual' | 'document' | 'thread';

export type ArtifactStatus = 'draft' | 'proposed' | 'approved' | 'rejected' | 'superseded' | 'stale';

export interface ArtifactVersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly createdAt: IsoDateTime;
  readonly note: string;
  /** Variation request text, if this version answered one (FR-ART-07). */
  readonly variationRequest?: string;
  readonly status: ArtifactStatus;
  /** Sent to counterparties (FR-ART-08). */
  readonly sentTo?: readonly { readonly counterparty: string; readonly at: IsoDateTime }[];
}

/** A founder action on an artifact; executed by the server, never locally. */
export interface ArtifactAction {
  readonly id: string;
  readonly label: string;
  readonly kind: 'command' | 'open';
  /** For kind 'open'. */
  readonly target?: Target;
  /** Changing an approved artifact runs the impact flow first. */
  readonly runsImpact?: boolean;
  /** Shown only while the founder views this version (e.g. "Adopt v3"). */
  readonly forVersionId?: string;
}

export interface ArtifactThumbnail {
  readonly kind: 'plates' | 'swatches' | 'icon';
  readonly plates?: readonly PlateExhibit[];
  readonly swatches?: readonly (readonly string[])[];
  readonly icon?: IconName;
}

export interface ArtifactView {
  readonly id: string;
  readonly type: ArtifactType;
  readonly title: string;
  readonly outcome: Outcome | null;
  readonly status: ArtifactStatus;
  readonly currentVersionId: string;
  readonly versions: readonly ArtifactVersionView[];
  /** Being generated now: show a skeleton in place. */
  readonly generating?: { readonly label: string } | null;
  readonly embed: { readonly subtitle: string; readonly thumbnail: ArtifactThumbnail };
  readonly icon: IconName;
  /** Open wide by default (visual canvases with several frames). */
  readonly preferWide?: boolean;
  readonly content: ArtifactContent;
  readonly actions: readonly ArtifactAction[];
}

export type ArtifactContent = CanvasContent | DocumentContent | ThreadContent;

/* ---------- canvas ---------- */

export interface CanvasContent {
  readonly kind: 'canvas';
  readonly frames: readonly FrameView[];
  /** Frame the camera fits on open. 'all' fits every frame. */
  readonly focusFrameId: string | 'all';
}

export interface CommentPin {
  readonly id: string;
  /** Position inside the frame, 0..1 of width and height. */
  readonly x: number;
  readonly y: number;
  readonly author: string;
  readonly text: string;
  readonly at: IsoDateTime;
  readonly resolved?: boolean;
}

export interface FrameComment {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly at: IsoDateTime;
}

export interface FrameView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  /** Status word shown in amber beside the title, e.g. "stale", "generating". */
  readonly statusNote?: string;
  readonly stale?: boolean;
  /** Preferred width in px at zoom 1. */
  readonly width: number;
  readonly row: number;
  readonly pinDecisionId?: string | null;
  readonly pins: readonly CommentPin[];
  readonly body: FrameBody;
  /** Bodies of other versions, so the inspector can show them side by side with the current one. */
  readonly versionBodies?: Readonly<Record<string, FrameBody>>;
  readonly inspector: InspectorView;
  /** Text alternative for the list fallback. */
  readonly summary: string;
}

export interface InspectorView {
  readonly typeLabel: string;
  readonly serves: Outcome | null;
  readonly versions: readonly ArtifactVersionView[];
  readonly currentVersionId: string;
  readonly evidence: readonly EvidenceItem[];
  readonly comments: readonly FrameComment[];
  readonly allowVariation: boolean;
  readonly actions: readonly ArtifactAction[];
}

export interface ShelfItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly plate: PlateExhibit;
  readonly price: Figure;
  readonly quantity: Figure;
  /** Quantity in the founder's limit unit, for the MOQ bar. */
  readonly quantityValue: number;
  readonly tag: 'recommended' | 'chosen' | null;
  /** Option this column selects on the active decision, if any. */
  readonly decisionOptionId?: string | null;
  readonly caption: string;
  readonly captionTone: 'neutral' | 'warning';
  readonly verification?: EvidenceItem;
}

export interface TableCell {
  readonly figure?: Figure;
  readonly text?: string;
  /** "not yet observed" cells are explicit (UX 7.3). */
  readonly unobserved?: boolean;
  readonly tone?: 'neutral' | 'warning';
  readonly why?: string;
  readonly notes?: readonly RichText[];
}

export interface TableRow {
  readonly label: string;
  readonly termId?: string;
  readonly cells: readonly TableCell[];
}

export type FrameBody =
  | {
      readonly k: 'shelf';
      readonly items: readonly ShelfItem[];
      /** The founder's limit, drawn as the accent tick. */
      readonly limit: { readonly value: number; readonly label: string } | null;
      readonly decisionId: string | null;
    }
  | {
      readonly k: 'table';
      readonly columns: readonly { readonly id: string; readonly label: string; readonly highlight?: boolean }[];
      readonly rows: readonly TableRow[];
      readonly legend: readonly GlyphTrust[];
      readonly footnote?: string;
    }
  | {
      readonly k: 'identity';
      readonly wordmark: string;
      readonly wordmarkAlt?: { readonly text: string; readonly lang: ContentLang };
      readonly mark: MarkGlyph | null;
      readonly palette: readonly string[];
      readonly background: number;
      readonly foreground: number;
      readonly typeface: 'serif' | 'sans';
      readonly positioning: string;
      readonly statusLabel: string;
      readonly versionChips: readonly {
        readonly versionId: string;
        readonly label: string;
        readonly current: boolean;
        readonly fresh?: boolean;
      }[];
      readonly generating?: { readonly label: string } | null;
    }
  | {
      readonly k: 'plates';
      readonly items: readonly PlateExhibit[];
      readonly caption: string;
      readonly generating?: { readonly label: string } | null;
    }
  | {
      readonly k: 'choices';
      readonly decisionId: string | null;
      readonly items: readonly {
        readonly optionId: string;
        readonly label: string;
        readonly plate: PlateExhibit;
        readonly chosen: boolean;
      }[];
    }
  | { readonly k: 'rich'; readonly paragraphs: readonly RichText[] };

/* ---------- document ---------- */

export type DocSection =
  | { readonly k: 'heading'; readonly text: string; readonly note?: string }
  | { readonly k: 'lead'; readonly text: RichText }
  | { readonly k: 'prose'; readonly paragraphs: readonly RichText[] }
  | {
      readonly k: 'fields';
      readonly rows: readonly { readonly label: string; readonly value: string; readonly previous?: string; readonly figure?: Figure }[];
      /** e.g. "v2 to v3" */
      readonly diffLabel?: string;
    }
  | { readonly k: 'plates'; readonly items: readonly PlateExhibit[]; readonly caption?: RichText }
  | {
      readonly k: 'grid';
      readonly cells: readonly { readonly title: string; readonly text: string; readonly evidence: EvidenceItem }[];
      readonly legend: readonly GlyphTrust[];
    }
  | { readonly k: 'code'; readonly text: string; readonly label: string }
  | { readonly k: 'gallery'; readonly items: readonly { readonly label: string; readonly caption: string; readonly plate: PlateExhibit }[] }
  | { readonly k: 'kit'; readonly kit: KitView }
  | { readonly k: 'actions'; readonly actions: readonly ArtifactAction[] };

export interface DocumentContent {
  readonly kind: 'document';
  readonly sections: readonly DocSection[];
}

/* ---------- thread ---------- */

export type Channel = 'email' | 'whatsapp' | 'voice' | 'sms' | 'marketplace' | 'web';

export interface ThreadText {
  readonly text: string;
  readonly lang: ContentLang;
}

export interface ThreadMessage {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound' | 'call';
  readonly channel: Channel;
  readonly at: IsoDateTime;
  readonly author: string;
  readonly original: ThreadText;
  /** Faithful translation shown beside the original. */
  readonly translation?: ThreadText;
  /** Mandate or approval that authorised an outbound effect. */
  readonly authority?: { readonly label: string; readonly evidence: EvidenceItem };
  readonly reference?: string;
  readonly figures?: readonly Figure[];
  readonly delivery: 'sent' | 'delivered' | 'failed' | 'received' | 'retrying';
  readonly failure?: { readonly reason: string; readonly retryStepId: string | null };
  readonly call?: {
    readonly durationMinutes: number;
    readonly summary: readonly string[];
    readonly recordingUrl?: string;
    /** Verbal terms stay claimed until confirmed in writing. */
    readonly evidence: EvidenceItem;
    readonly confirmation: string;
  };
  readonly attachments?: readonly { readonly label: string; readonly versionLabel: string; readonly sentAt: IsoDateTime }[];
}

export interface DraftView {
  readonly id: string;
  readonly channel: Channel;
  readonly original: ThreadText;
  readonly translation?: ThreadText;
  /** Why it is held, e.g. "Held for you because Supplier B is set to Guide me." */
  readonly heldBecause: string;
  readonly mandateUsage: string;
  readonly evidence: EvidenceItem;
}

export interface ThreadContent {
  readonly kind: 'thread';
  readonly counterparty: { readonly name: string; readonly subtitle: string; readonly verification?: EvidenceItem };
  readonly help: HelpModeControl;
  readonly messages: readonly ThreadMessage[];
  readonly draft: DraftView | null;
  readonly note?: string;
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

export type DecisionKind = 'selection' | 'mandate' | 'payment' | 'visual' | 'change' | 'terminal' | 'goal' | 'constraint' | 'engagement';
export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'deferred' | 'superseded';

export interface DecisionOptionView {
  readonly id: string;
  readonly label: RichText;
  /** Short label for receipts and "Choose …" buttons, e.g. "split order". */
  readonly shortLabel: string;
  /** Button text when this option is selected, naming the action ("Approve stock bottle"). */
  readonly actionLabel: string;
  readonly description: RichText;
  readonly effects: readonly { readonly label: string; readonly value: string }[];
  /** Visual decisions carry a drawing (FR-EASE-09). */
  readonly visual?: PlateExhibit;
  readonly cost?: Figure | null;
}

/** Editable mandate scope for the mandate-grant variant (UX 7.5). */
export interface MandateScopeDraft {
  readonly ceiling: Money;
  /** Bounds the founder may choose within; the server validates again. */
  readonly ceilingMax: Money;
  readonly perItemCeiling?: Money;
  readonly count: number;
  readonly countMax: number;
  readonly countUnit: string;
  readonly expiresOn: IsoDate;
  readonly expiresMax: IsoDate;
  readonly channels?: readonly string[];
  /**
   * The exact options whose frozen refs carry this mandate version. The scope is shown, edited and sent
   * only while one of these is selected. Every real projection supplies it; when absent (older test
   * fixtures) the recommended option is assumed.
   */
  readonly optionIds?: readonly string[];
}

/** Payment packet variant: ends in an approval on the provider page (UX 7.5, J6). */
export interface PaymentPacket {
  readonly payee: string;
  readonly purpose: string;
  readonly amount: Figure;
  readonly converted?: { readonly amount: Money; readonly rate: string; readonly rateSource: SourceRef };
  readonly mandate: string | null;
  readonly provider: string;
  /** e.g. "Approve on PayPal" */
  readonly providerActionLabel: string;
  readonly sandbox: boolean;
  readonly instrumentLabel: string;
  /** The exact options whose frozen refs carry this payment version (see MandateScopeDraft.optionIds). */
  readonly optionIds?: readonly string[];
}

export interface DecisionView {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly topic: string;
  readonly question: string;
  readonly context: RichText;
  readonly options: readonly DecisionOptionView[];
  readonly recommendedOptionId: string;
  readonly why: readonly RichText[];
  readonly binding: boolean;
  readonly needsBy: IsoDateTime | null;
  /** Default-if-no-answer line; binding decisions never auto-resolve. */
  readonly defaultLine: string;
  readonly status: DecisionStatus;
  readonly resolution: {
    readonly optionId: string;
    readonly how: 'founder' | 'default';
    readonly at: IsoDateTime;
  } | null;
  readonly deferredUntil?: string | null;
  readonly supersededById: string | null;
  readonly supersedesId: string | null;
  /** Approved and reversible: shows "Change this". */
  readonly canChange: boolean;
  /** Evidence surface: the peek follows the decision (moment ritual, embed). */
  readonly evidence: { readonly artifactId: string; readonly frameId?: string } | { readonly system: SystemPeek } | null;
  readonly mandateScope?: MandateScopeDraft;
  readonly payment?: PaymentPacket;
  /** What deferring holds back (FR-DEC-07). */
  readonly blocks?: string;
  readonly stale?: boolean;
}

export interface DecisionMomentView {
  readonly id: string;
  readonly decisionIds: readonly string[];
  readonly estimateMinutes: number;
  /** OD-U4: open the ritual automatically on return when 2+ decisions wait. */
  readonly autoOpen: boolean;
}

/* ------------------------------------------------------------------ */
/* Readiness, activity, commitments, money, mandates                   */
/* ------------------------------------------------------------------ */

export interface ReadinessOutcomeView {
  readonly outcome: Outcome;
  readonly level: ReadinessLevel;
  readonly blocker: string;
  readonly staleNote: string | null;
  /** Evidence per rung R1..R5; empty when not met. */
  readonly rungs: readonly {
    readonly level: Exclude<ReadinessLevel, 0>;
    readonly met: boolean;
    readonly evidence: readonly EvidenceItem[];
    readonly missing: string;
  }[];
}

export interface ReadinessView {
  readonly outcomes: readonly ReadinessOutcomeView[];
  /** Outcomes in scope (Demand pending OD-15). */
  readonly inScope: readonly Outcome[];
}

export type StepLabel =
  | 'planned'
  | 'running'
  | 'performed'
  | 'claimed'
  | 'verified'
  | 'corrected'
  | 'failed'
  | 'waiting'
  | 'blocked'
  | 'proposed'
  | 'approved'
  | 'retrying';

export interface HelpModeControl {
  readonly targetId: string;
  readonly targetKind: 'thread' | 'commitment' | 'activity';
  readonly mode: HelpMode;
  readonly allowed: readonly HelpMode[];
}

export interface ActivityStep {
  readonly id: string;
  readonly label: StepLabel;
  readonly title: RichText;
  readonly details: readonly RichText[];
  readonly at: IsoDateTime;
  readonly retry?: { readonly label: string } | null;
  readonly help?: HelpModeControl | null;
  readonly receipts?: readonly EvidenceItem[];
  readonly sandbox?: boolean;
}

export interface CommitmentView {
  readonly id: string;
  readonly owedBy: string;
  readonly owedTo: string;
  readonly what: string;
  readonly due: IsoDateTime;
  readonly overdueDays: number;
  readonly escalation?: string;
  readonly recommendedAction?: string;
  readonly help?: HelpModeControl | null;
  readonly status: 'open' | 'done' | 'cancelled';
}

export interface DecisionRecordEntry {
  readonly id: string;
  readonly decisionId: string | null;
  readonly at: IsoDateTime;
  readonly status: 'approved' | 'superseded' | 'rejected' | 'default';
  readonly text: string;
  readonly canChange: boolean;
  readonly supersededById?: string | null;
}

export type MandateUsage =
  | { readonly kind: 'count'; readonly used: number; readonly ceiling: number; readonly unit: string }
  | { readonly kind: 'money'; readonly used: Money; readonly ceiling: Money };

export interface MandateView {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly status: 'active' | 'requested' | 'revoked' | 'expired' | 'standing' | 'exhausted';
  readonly usage: MandateUsage | null;
  readonly expiresAt: IsoDateTime | null;
  /** The two strip meters (UX 5.1). */
  readonly inStrip: boolean;
  readonly requestDecisionId?: string | null;
  readonly revokedNote?: string | null;
}

export interface EnvelopeView {
  readonly id: string;
  readonly name: string;
  readonly allocated: Money;
  readonly spent: Money;
  readonly committed: Money;
  readonly forecast: Money;
}

export interface ReceiptView {
  readonly id: string;
  readonly at: IsoDateTime;
  readonly payee: string;
  readonly purpose: string;
  readonly amount: Figure;
  readonly reference: string;
  readonly sandbox: boolean;
}

export interface MoneyTotals {
  readonly budget: Money;
  readonly spent: Money;
  readonly committed: Money;
  readonly forecast: Figure;
  readonly left: Money;
  readonly headroom: Money;
}

export interface MoneyView {
  readonly currency: string;
  readonly totals: MoneyTotals;
  readonly envelopes: readonly EnvelopeView[];
  readonly mandates: readonly MandateView[];
  readonly receipts: readonly ReceiptView[];
  /** Sandbox receipts are never counted as real spend (I-16). */
  readonly sandbox: { readonly totals: Pick<MoneyTotals, 'spent' | 'committed'>; readonly receipts: readonly ReceiptView[] } | null;
}

/* ------------------------------------------------------------------ */
/* Page entries (the page is the conversation)                         */
/* ------------------------------------------------------------------ */

export interface ChangeRow {
  readonly id: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly direction: 'up' | 'down' | 'neutral';
  readonly target?: Target;
  readonly receipt?: EvidenceItem;
}

export interface ImpactView {
  readonly id: string;
  readonly decisionId: string | null;
  readonly title: string;
  readonly stale: readonly string[];
  /** Second-order dependents from lineage edges, each with why it is affected. */
  readonly secondOrder: readonly { readonly label: string; readonly via: string }[];
  readonly readiness: readonly { readonly outcome: Outcome; readonly from: ReadinessLevel; readonly to: ReadinessLevel }[];
  readonly cost: string;
  readonly time: string;
  readonly redo: readonly string[];
  readonly confirmLabel: string;
  readonly status: 'open' | 'confirmed' | 'kept';
}

export interface QuestionView {
  readonly id: string;
  readonly prompt: RichText;
  readonly recommended: string;
  readonly options: readonly string[];
  readonly status: 'open' | 'answered' | 'skipped';
  readonly answer?: string;
  readonly index: number;
  readonly total: number;
}

export interface KitView {
  readonly id: string;
  readonly title: string;
  readonly estimateMinutes: number;
  readonly where: { readonly label: string; readonly url?: string };
  readonly enter: readonly string[];
  readonly bring: readonly string[];
  readonly verify: string;
  readonly status: 'ready' | 'in_progress' | 'submitted' | 'verified';
}

/** Launch Record export. zip = the asset package: Record JSON + Markdown, every scoped image and a SHA-256 manifest. */
export type ExportFormat = 'pdf' | 'markdown' | 'json' | 'zip';

export type TerminalKind = 'launch' | 'pivot' | 'stop' | 'infeasible';

export interface ClosingRecordView {
  readonly id: string;
  readonly terminal: TerminalKind;
  readonly decidedAt: IsoDateTime;
  readonly summary: readonly RichText[];
  readonly openCommitments: readonly { readonly commitmentId: string; readonly what: string; readonly recommendedAction: string }[];
  readonly accounts: readonly { readonly name: string; readonly owner: string }[];
  readonly exportFormats: readonly ExportFormat[];
}

export type Block =
  | { readonly k: 'lede'; readonly text: RichText }
  | { readonly k: 'prose'; readonly paragraphs: readonly RichText[] }
  | { readonly k: 'decision'; readonly decisionId: string }
  | { readonly k: 'moment' }
  | { readonly k: 'embed'; readonly artifactId: string }
  | { readonly k: 'changes'; readonly title?: string; readonly rows: readonly ChangeRow[] }
  | { readonly k: 'readiness'; readonly from: OutcomeLevels; readonly to: OutcomeLevels; readonly blockersFor: readonly Outcome[] }
  | { readonly k: 'steps'; readonly stepIds: readonly string[] }
  | { readonly k: 'impact'; readonly impactId: string }
  | { readonly k: 'question'; readonly questionId: string }
  | { readonly k: 'document'; readonly artifactId: string }
  | { readonly k: 'skeleton'; readonly label: string; readonly height: number; readonly artifactId?: string }
  | { readonly k: 'empty'; readonly text: string }
  | { readonly k: 'suggestions'; readonly items: readonly string[] }
  | { readonly k: 'money' }
  | { readonly k: 'kit'; readonly kitId: string }
  | { readonly k: 'closing'; readonly recordId: string };

export interface PageEntry {
  readonly id: string;
  readonly author: 'agent' | 'founder';
  readonly at: IsoDateTime;
  /** Agent text still arriving: show the caret. */
  readonly streaming: boolean;
  /** Superseded: dim the entry, show the note. */
  readonly staleNote: string | null;
  readonly blocks: readonly Block[];
  /** Founder messages. */
  readonly text?: string;
  readonly delivery?: 'sending' | 'sent' | 'failed';
}

/* ------------------------------------------------------------------ */
/* Mission, notifications, connection, access                          */
/* ------------------------------------------------------------------ */

export interface MissionSummary {
  readonly id: string;
  readonly name: string;
  readonly untitled: boolean;
  readonly icon: MarkGlyph | null;
  readonly pendingDecisions: number;
  readonly overdueCommitments: number;
  readonly levels: OutcomeLevels;
  readonly status: 'active' | 'paused' | 'ended';
  readonly sandbox: boolean;
  /** One-line description for the palette, e.g. the category line from seed data. */
  readonly line: string;
}

export interface WorkingLine {
  readonly state: 'planning' | 'working' | 'waiting' | 'idle' | 'paused' | 'blocked';
  readonly text: string;
}

export interface NotificationView {
  readonly id: string;
  readonly kind: 'decision' | 'mandate' | 'payment' | 'failure' | 'reply' | 'digest';
  readonly immediate: boolean;
  readonly title: string;
  readonly why: string;
  readonly amount?: Money | null;
  readonly at: IsoDateTime;
  readonly read: boolean;
  readonly target: Target;
  /** Approve directly from the notification (FR-UX-12). */
  readonly decisionId?: string | null;
}

export interface NotificationSettingsView {
  readonly momentsPerWeek?: number;
  readonly digestCadence: 'daily' | 'twice_weekly' | 'weekly';
  readonly quietHours: { readonly from: string; readonly to: string } | null;
}

export type ConnectionStatus = 'live' | 'connecting' | 'reconnecting' | 'offline';

export interface ConnectionView {
  readonly status: ConnectionStatus;
  readonly lastSyncedAt: IsoDateTime | null;
}

export interface AccessView {
  readonly role: 'owner' | 'approver' | 'commenter' | 'viewer';
  readonly canDecide: boolean;
  readonly canMessage: boolean;
  readonly canGrantMandates: boolean;
  readonly reason?: string;
}

export interface SinceYouLeftView {
  readonly from: IsoDateTime;
  readonly to: IsoDateTime;
  readonly stepIds: readonly string[];
  readonly overdueCommitmentIds: readonly string[];
  readonly waitingDecisionIds: readonly string[];
}

export interface MissionHeader {
  readonly activeTime?: Figure;
  readonly knowledge?: {
    readonly category: string;
    readonly version: number;
    readonly reviewStatus: 'unverified' | 'reviewed';
    readonly warning: string | null;
    readonly sources: readonly string[];
  };
  readonly name: string;
  readonly untitled: boolean;
  readonly altName?: { readonly text: string; readonly lang: ContentLang } | null;
  /** Category line from seed data, e.g. "Perfume launch in Saudi Arabia". */
  readonly line: string;
  readonly week: number | null;
  readonly budget: Money | null;
  readonly budgetDecisionId?: string | null;
}

/** The serializable projection the workspace renders. Produced by the server from the ledgers. */
export interface MissionView {
  /** Monotonic ledger version; commands report the version that reflects them. */
  readonly ledgerVersion: number;
  readonly missionId: string;
  readonly generatedAt: IsoDateTime;
  readonly timeZone: string;
  readonly contentLang: ContentLang;
  readonly header: MissionHeader;
  readonly status: 'active' | 'paused' | 'ended';
  readonly sandbox: boolean;
  readonly working: WorkingLine;
  readonly sinceYouLeft: SinceYouLeftView | null;
  readonly entries: readonly PageEntry[];
  readonly decisions: Readonly<Record<string, DecisionView>>;
  readonly moment: DecisionMomentView | null;
  readonly artifacts: Readonly<Record<string, ArtifactView>>;
  readonly activity: Readonly<Record<string, ActivityStep>>;
  /** Order for the Log peek, most recent first. */
  readonly activityOrder: readonly string[];
  readonly commitments: readonly CommitmentView[];
  readonly decisionRecord: readonly DecisionRecordEntry[];
  readonly readiness: ReadinessView;
  readonly money: MoneyView;
  readonly impacts: Readonly<Record<string, ImpactView>>;
  readonly questions: Readonly<Record<string, QuestionView>>;
  readonly kits: Readonly<Record<string, KitView>>;
  readonly closingRecords: Readonly<Record<string, ClosingRecordView>>;
  readonly glossary: Readonly<Record<string, GlossaryEntry>>;
  /** The agent's requested focus (FR-UX-03). */
  readonly focus: { readonly target: Target; readonly reason: string } | null;
  readonly notifications: readonly NotificationView[];
  readonly notificationSettings: NotificationSettingsView;
  /** "How drawings are made": specimens are seed data, not code. */
  readonly plateSpecimens: readonly { readonly label: string; readonly plate: PlateExhibit }[];
  readonly access: AccessView;
  /** Suggested founder questions that are always answerable (unknown-input fallback). */
  readonly suggestions: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

export type CommandErrorCode =
  'offline' | 'unavailable' | 'forbidden' | 'conflict' | 'validation' | 'rate_limited' | 'needs_approval' | 'unknown';

export interface CommandError {
  readonly code: CommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type CommandResult =
  | {
      readonly ok: true;
      /** The ledger version that reflects this command. The UI shows the outcome only once view.ledgerVersion reaches it. */
      readonly ledgerVersion: number;
      /** Provider approval page (payments). The UI navigates there; the ledger updates on return. */
      readonly redirectUrl?: string;
      /** Export download (Launch Record). The host navigates to it (same origin only); the workspace does not, so it never downloads twice. */
      readonly downloadUrl?: string;
      /** New mission id after createMission. */
      readonly missionId?: string;
    }
  | { readonly ok: false; readonly error: CommandError };

/** Every command carries an idempotency key; retries of one attempt reuse it (I-4). */
export interface CommandBase {
  readonly missionId: string;
  readonly idempotencyKey: string;
  /** The ledger version the founder saw when acting. */
  readonly seenLedgerVersion: number;
}

export interface ResolveDecisionInput extends CommandBase {
  readonly decisionId: string;
  readonly response: 'approve' | 'choose' | 'reject';
  readonly optionId: string;
  readonly mandateScope?: { readonly ceiling: Money; readonly count: number; readonly expiresOn: IsoDate };
}

export interface MessageContext {
  readonly artifactId?: string;
  readonly frameId?: string;
  readonly versionId?: string;
  readonly decisionId?: string;
  /** Positional comment pin, 0..1 inside the frame. */
  readonly point?: { readonly x: number; readonly y: number };
}

export interface MissionCommands {
  readonly resolveDecision: (input: ResolveDecisionInput) => Promise<CommandResult>;
  readonly deferDecision: (input: CommandBase & { readonly decisionId: string }) => Promise<CommandResult>;
  /** Asks the server for an impact analysis; the impact block arrives in the view. */
  readonly requestChange: (
    input:
      | (CommandBase & { readonly decisionId: string })
      | (CommandBase & { readonly artifactId: string; readonly versionId: string; readonly actionId: string }),
  ) => Promise<CommandResult>;
  readonly confirmChange: (input: CommandBase & { readonly impactId: string }) => Promise<CommandResult>;
  readonly keepDecision: (input: CommandBase & { readonly impactId: string }) => Promise<CommandResult>;
  /** Applies defaults to non-binding decisions; binding ones stay open (FR-EASE-10). */
  readonly justGo: (input: CommandBase & { readonly momentId: string | null }) => Promise<CommandResult>;
  /** Closes a decision moment so the server writes one "What changed in this moment". */
  readonly completeMoment: (
    input: CommandBase & { readonly momentId: string; readonly resolvedDecisionIds: readonly string[] },
  ) => Promise<CommandResult>;
  readonly sendMessage: (input: CommandBase & { readonly text: string; readonly context?: MessageContext }) => Promise<CommandResult>;
  readonly answerQuestion: (
    input: CommandBase & { readonly questionId: string; readonly answer: string; readonly skipped: boolean },
  ) => Promise<CommandResult>;
  readonly setHelpMode: (
    input: CommandBase & { readonly control: Pick<HelpModeControl, 'targetId' | 'targetKind'>; readonly mode: HelpMode },
  ) => Promise<CommandResult>;
  readonly approveDraft: (input: CommandBase & { readonly artifactId: string; readonly draftId: string }) => Promise<CommandResult>;
  readonly discardDraft: (input: CommandBase & { readonly artifactId: string; readonly draftId: string }) => Promise<CommandResult>;
  readonly retryStep: (input: CommandBase & { readonly stepId: string }) => Promise<CommandResult>;
  readonly requestVariation: (
    input: CommandBase & { readonly artifactId: string; readonly frameId: string; readonly versionId: string; readonly request: string },
  ) => Promise<CommandResult>;
  readonly runArtifactAction: (
    input: CommandBase & { readonly artifactId: string; readonly actionId: string; readonly frameId?: string; readonly versionId?: string },
  ) => Promise<CommandResult>;
  readonly setMandateStatus: (input: CommandBase & { readonly mandateId: string; readonly status: 'revoked' }) => Promise<CommandResult>;
  readonly setMissionStatus: (input: CommandBase & { readonly status: 'paused' | 'active' }) => Promise<CommandResult>;
  readonly setTraceRetention: (input: CommandBase & { readonly enabled: boolean }) => Promise<CommandResult>;
  readonly keepRetainedContent: (input: CommandBase & { readonly objectId: string; readonly keep: boolean }) => Promise<CommandResult>;
  readonly markNotificationsRead: (input: CommandBase & { readonly notificationIds: readonly string[] }) => Promise<CommandResult>;
  readonly updateNotificationSettings: (input: CommandBase & { readonly settings: NotificationSettingsView }) => Promise<CommandResult>;
  readonly exportLaunchRecord: (input: CommandBase & { readonly format: ExportFormat }) => Promise<CommandResult>;
  readonly createMission: (input: Omit<CommandBase, 'missionId' | 'seenLedgerVersion'>) => Promise<CommandResult>;
}

/** Navigation and preferences are not ledger writes; the host owns routing and persistence. */
export interface WorkspaceHost {
  readonly selectMission: (missionId: string) => void;
  readonly setPreferences: (prefs: { readonly theme?: Theme; readonly language?: UiLanguage }) => void;
  /** Deep link to an entry, decision or artifact (notifications, palette). */
  readonly buildHref?: (target: Target) => string;
  /**
   * Account actions (FR-ACC-06). Optional: when absent the workspace calls the documented routes
   * GET/DELETE /api/missions/{id}/deletion and DELETE /api/session.
   */
  readonly loadDeletionNotice?: (missionId: string) => Promise<DeletionNotice>;
  readonly deleteMission?: (missionId: string) => Promise<DeletionResult>;
  readonly signOut?: () => Promise<void>;
  /**
   * Founder-owned accounts the agent can use (FR-ACC-01/02). Optional: when absent the workspace calls
   * the routes in docs/implementation/ACCOUNT-API.md directly.
   */
  readonly loadAccounts?: (missionId: string) => Promise<AccountsView>;
  readonly revokeAccount?: (missionId: string, accountId: string) => Promise<AccountRevocation>;
  readonly connectShopify?: (missionId: string, shopDomain: string) => Promise<ShopifyConnectResult>;
}

/** Connection status per docs/implementation/ACCOUNT-API.md. There is deliberately no "verified" state. */
export type AccountStatus = 'connected' | 'revoked';

export interface AccountView {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  readonly status: AccountStatus;
  /**
   * Read-only account check. `passed` means the provider check succeeded; it is NOT legal ownership,
   * KYC, publishing readiness or proof of any business effect. `pending` shows "Verification pending".
   */
  readonly check: 'passed' | 'pending';
  readonly checkedAt: IsoDateTime | null;
  /** Safe explanation (restricted key, incomplete sending domain). Never a credential. */
  readonly reason: string;
  /** Ownership is founder-attested; revoking removes the agent's access only. */
  readonly ownership: 'founder_attested' | 'unknown';
  readonly sandbox: boolean;
  readonly scopes: readonly string[];
  readonly connectedAt: IsoDateTime | null;
  readonly canRevoke: boolean;
}

export interface AccountsView {
  readonly accounts: readonly AccountView[];
}

export type AccountRevocation =
  { readonly ok: true; readonly revokedAt: IsoDateTime | null } | { readonly ok: false; readonly message: string };

/** Optional Shopify install: shop domain plus the founder's ownership attestation; no secrets. */
export type ShopifyConnectResult =
  { readonly ok: true; readonly authorizationUrl: string } | { readonly ok: false; readonly message: string };

/** What stays the founder's when a mission is deleted. Items are listed as the server reports them. */
export interface DeletionNotice {
  readonly retainedAccounts: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly retainedExternalAssets: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
  readonly notice: string;
}

export type DeletionResult = { readonly ok: true; readonly receiptId: string } | { readonly ok: false; readonly message: string };

export interface MissionWorkspaceProps {
  readonly view: MissionView;
  readonly missions: readonly MissionSummary[];
  readonly connection: ConnectionView;
  readonly commands: MissionCommands;
  readonly host: WorkspaceHost;
  readonly theme: Theme;
  readonly language: UiLanguage;
  /** Initial deep link target (from the URL). */
  readonly initialTarget?: Target | null;
}

/* ------------------------------------------------------------------ */
/* Icons (drawn in the product, 16px, 1.5 stroke)                       */
/* ------------------------------------------------------------------ */

export type IconName =
  | 'plus'
  | 'search'
  | 'close'
  | 'chev'
  | 'expand'
  | 'shrink'
  | 'mail'
  | 'chat'
  | 'phone'
  | 'check'
  | 'clock'
  | 'doc'
  | 'coins'
  | 'shelf'
  | 'swatch'
  | 'ladder'
  | 'list'
  | 'flag'
  | 'retry'
  | 'pen'
  | 'enter'
  | 'box'
  | 'arrow'
  | 'undo'
  | 'moon'
  | 'globe'
  | 'ruler'
  | 'minus'
  | 'fit'
  | 'pause'
  | 'bell'
  | 'send'
  | 'download'
  | 'lock'
  | 'wifi'
  | 'kit'
  | 'pin'
  | 'play';
