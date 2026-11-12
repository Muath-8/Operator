import type { EvalReport, QualityEvidence } from './contracts.js';

export type Phase = 'R0' | 'R1' | 'R2' | 'R3' | 'GA';
export interface ReleaseCheck {
  id: string;
  status: 'pass' | 'fail' | 'blocked';
  reason: string;
  evidenceIds: string[];
}
export interface ReleaseReport {
  phase: Phase;
  status: 'pass' | 'fail' | 'blocked';
  checks: ReleaseCheck[];
}
function consecutiveNights(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 3 || !value.every(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))) return false;
  const days = [...new Set(value as string[])].map(v => Date.parse(v + 'T00:00:00Z')).sort((a, b) => a - b);
  return days.length >= 3 && days.every((v, i) => i === 0 || v - (days[i - 1] ?? 0) === 86400000);
}
/** Facts must come from hash-verified tool artifacts. No absence is success. */
export function releaseGates(phase: Phase, report: EvalReport, evidence: readonly QualityEvidence[]): ReleaseReport {
  const checks: ReleaseCheck[] = [];
  for (const issue of report.externalGates.filter(g => g.id === 'integrity' && g.status !== 'pass'))
    checks.push({ ...issue, id: 'integrity', evidenceIds: [] });
  if (report.mode === 'test')
    checks.push({
      id: 'integrity.test_report',
      status: 'fail',
      reason: 'Test-mode reports cannot satisfy any release phase',
      evidenceIds: [],
    });
  const fact = (
    id: string,
    kind: QualityEvidence['kind'],
    predicate: (facts: QualityEvidence['facts']) => boolean,
    description: string,
  ) => {
    const records = evidence.filter(e => e.kind === kind && e.exitCode === 0);
    const satisfied = records.find(e => predicate(e.facts));
    checks.push({
      id,
      status: satisfied ? 'pass' : records.length ? 'fail' : 'blocked',
      reason: description,
      evidenceIds: satisfied ? [satisfied.id] : records.map(e => e.id),
    });
  };
  const metric = (id: string) => {
    const measured = report.metrics.find(m => m.id === id);
    checks.push({
      id,
      status: measured?.status ?? 'blocked',
      reason: measured?.reason ?? `Required measured metric ${id}`,
      evidenceIds: report.measurements.filter(m => m.status === 'completed').map(m => m.caseId),
    });
  };
  const phases: Phase[] = ['R0', 'R1', 'R2', 'R3', 'GA'];
  const index = phases.indexOf(phase);
  fact(
    'invariants.foundation',
    'security',
    f =>
      ['I-1', 'I-2', 'I-3', 'I-4', 'I-5', 'I-6', 'I-7', 'I-8', 'I-11', 'I-12', 'I-16'].every(
        i => Array.isArray(f['passedInvariantIds']) && f['passedInvariantIds'].includes(i),
      ) && f['invariantFailures'] === 0,
    'Foundation invariants I-1..8,11,12,16 must all pass',
  );
  fact(
    'policy.property_10000',
    'unit',
    f => Number(f['policyPropertyCases']) >= 10000 && f['failedTests'] === 0,
    'At least 10000 policy property cases, no failed tests',
  );
  fact(
    'database.complete_matrix',
    'database',
    f => f['roleTableCoverage'] === 1 && f['crossTenantLeaks'] === 0 && f['failedTests'] === 0,
    '100% roles × tables and zero cross-tenant leakage',
  );
  fact(
    'replay.no_duplicate_effects',
    'fault_injection',
    f => f['restartReplayed'] === true && f['duplicateEffects'] === 0,
    'Scripted mission survives restart with zero duplicate effects',
  );
  fact(
    'broadcast.p95_under_2s',
    'performance',
    f => typeof f['broadcastP95Ms'] === 'number' && f['broadcastP95Ms'] < 2000,
    'Real private Broadcast visibility p95 <2000ms',
  );
  fact(
    'ui.home_under_25',
    'e2e',
    f => Number(f['visibleHomeElements']) <= 25 && f['width'] === 1440 && f['height'] === 900,
    'Seeded home ≤25 visible elements at1440×900',
  );
  if (index >= 1) {
    for (const id of ['extraction.field_accuracy', 'extraction.disagreements_flagged', 'negotiation.bound_violations', 'honesty.incidents'])
      metric(id);
    fact(
      'vertical_slice.three_nights',
      'scenario',
      f => consecutiveNights(f['consecutiveNights']) && f['sameReleaseCommit'] === true && f['allPassed'] === true,
      'Three consecutive unattended nights on the same release candidate',
    );
    fact(
      'payment.sandbox_paths',
      'contract',
      f => f['paypalApproveCaptureWebhookContinue'] === true && f['paypalDeclinedPath'] === true,
      'Actual PayPal sandbox approval/capture/webhook/continue and declined path',
    );
    fact(
      'effort.under_10min',
      'scenario',
      f => typeof f['founderEffortMs'] === 'number' && f['founderEffortMs'] < 600000,
      'Demonstration founder effort <10minutes',
    );
    fact(
      'coverage.minimums',
      'unit',
      f => Number(f['stateLineCoverage']) >= 90 && Number(f['policyLineCoverage']) >= 90 && Number(f['otherLineCoverage']) >= 80,
      'State/policy90% line coverage and80% elsewhere',
    );
    fact(
      'adapters.contract_failure_injection',
      'contract',
      f => f['contractCoverage'] === 1 && f['failureInjectionCoverage'] === 1 && f['failedTests'] === 0,
      'All adapters in use pass contract and injected-failure matrices',
    );
    fact(
      'security.fast_set',
      'security',
      f => f['highFindings'] === 0 && f['mediumFindings'] === 0 && f['failedTests'] === 0,
      'Security fast set has zero findings above low',
    );
  }
  if (index >= 2) {
    for (const m of report.metrics) if (!checks.some(c => c.id === m.id)) metric(m.id);
    for (const gate of report.externalGates) checks.push({ ...gate, evidenceIds: [] });
    for (const c of report.calibration)
      checks.push({
        id: `calibration.${c.rubric}`,
        status: c.status,
        reason: c.reason,
        evidenceIds: [],
      });
    fact(
      'ui.variants_phone_desktop',
      'visual_accessibility',
      f =>
        f['lightDarkLtrRtlDesktopPhone'] === true &&
        f['unreviewedDiffs'] === 0 &&
        f['axeViolations'] === 0 &&
        f['manualScreenReaderJourneys'] === 3,
      'All scenes4variants at1440/390, zero axe, reviewed visual diffs, three screen-reader journeys',
    );
    fact(
      'performance.ui_budgets',
      'performance',
      f =>
        Number(f['lcpP75Ms']) <= 2000 &&
        Number(f['inpP75Ms']) <= 200 &&
        Number(f['clsP75']) <= 0.05 &&
        Number(f['initialJsCompressedBytes']) <= 250000 &&
        Number(f['canvasFps12Frames']) >= 55 &&
        f['midrangeLaptopAndAndroid'] === true,
      'Measured p75 UI budgets on both reference device classes',
    );
    fact(
      'arabic.native_review',
      'visual_accessibility',
      f => f['nativeArabicApproved'] === true && typeof f['reviewerId'] === 'string',
      'Named native Arabic review required',
    );
    fact(
      'flexibility.second_category',
      'scenario',
      f => f['secondCategoryPass'] === true && f['categoryCodeHits'] === 0 && f['secondOrderImpactListed'] === true,
      'Second category unchanged code, zero category hits, second-order go-back',
    );
  }
  if (index >= 3) {
    fact(
      'field.shadowed_pilots',
      'field',
      f => Number(f['shadowedMissions']) >= 3 && Number(f['shadowedMissions']) <= 5 && f['correctionTrendDownThreeWeeks'] === true,
      '3–5 real shadowed missions; correction rate decreases for3weeks',
    );
    fact(
      'defects.release_blockers',
      'field',
      f => f['openS0'] === 0 && f['openS1'] === 0 && f['openS2'] === 0 && typeof f['qaSigner'] === 'string',
      'No open S0–S2, QA signature',
    );
    fact(
      'recovery.drills',
      'fault_injection',
      f => f['deployMidRun'] === true && f['webhookLoss'] === true && f['restoreDrill'] === true,
      'Deployment, webhook-loss and restore drills passed',
    );
    fact(
      'penetration.closed',
      'security',
      f => f['penetrationTestCompleted'] === true && f['openAboveLow'] === 0,
      'Penetration findings above low closed',
    );
    fact(
      'slo.two_weeks',
      'performance',
      f =>
        Number(f['productionMeasuredDays']) >= 14 &&
        Number(f['messageAckP95Ms']) < 5000 &&
        Number(f['ledgerAnswerP95Ms']) < 30000 &&
        Number(f['inboundFiledP95Ms']) < 900000 &&
        Number(f['inboundActedP95Ms']) < 14400000 &&
        Number(f['dueActedMaxMs']) <= 3600000 &&
        Number(f['tickSuccessRate']) >= 0.995 &&
        f['lostEvents'] === 0 &&
        f['duplicateEffects'] === 0 &&
        Number(f['pitrDays']) >= 30 &&
        f['dailySecondRegionBackup'] === true &&
        f['resumeIdenticalAfter180Days'] === true,
      'All §7.1 SLOs measured for14days including backups and idle-resume evidence',
    );
  }
  if (index >= 4) {
    fact(
      'ga.metrics_review',
      'field',
      f => f['betaMetricsApproved'] === true && f['operatorRunbookExercised'] === true,
      'BRD success metrics review and exercised operator runbook',
    );
    fact(
      'ga.legal_final',
      'legal',
      f => f['legalTextsFinal'] === true && typeof f['approvedBy'] === 'string',
      'BRD OD-11/OD-19 legal texts approved',
    );
  }
  return {
    phase,
    status: checks.some(c => c.status === 'fail') ? 'fail' : checks.some(c => c.status === 'blocked') ? 'blocked' : 'pass',
    checks,
  };
}
