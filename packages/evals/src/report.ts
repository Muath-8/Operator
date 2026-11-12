import { z } from 'zod';
import {
  EXPECTED_COUNTS,
  FixtureSchema,
  RUBRICS,
  SUITES,
  DomainReviewSchema,
  EvalReportSchema,
  type EvalFixture,
  type EvalReport,
  type HumanScore,
  type JudgeResult,
  type Measurement,
  type QualityEvidence,
} from './contracts.js';
import { aggregateMetrics, cohensKappa, gate, THRESHOLDS } from './metrics.js';
import { hash } from './runner.js';

export function validateCorpus(raw: readonly EvalFixture[]): string[] {
  const fixtures = z.array(FixtureSchema).parse(raw),
    issues: string[] = [];
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) issues.push('Duplicate fixture IDs');
  for (const suite of SUITES)
    if (fixtures.filter(f => f.suite === suite).length !== EXPECTED_COUNTS[suite])
      issues.push(`${suite}: expected ${EXPECTED_COUNTS[suite]} cases`);
  const extraction = fixtures.filter(f => f.suite === 'extraction');
  if (new Set(extraction.map(f => f.language)).size < 4) issues.push('Extraction needs four languages');
  if (new Set(extraction.map(f => f.format)).size < 6) issues.push('Extraction needs six formats');
  const products = fixtures.filter(f => f.suite === 'product');
  if (new Set(products.map(f => JSON.stringify(f.input['profile']))).size < 4) issues.push('Product needs four profiles');
  if (fixtures.filter(f => f.suite === 'reviewer' && f.expected['defective'] === true).length !== 20)
    issues.push('Reviewer corpus needs twenty seeded defects');
  if (fixtures.filter(f => f.suite === 'scenario' && f.judging).length !== 5) issues.push('Scenario corpus needs five judging missions');
  return issues;
}
export function calibrate(runId: string, judges: readonly JudgeResult[], human: readonly HumanScore[]): EvalReport['calibration'] {
  return RUBRICS.map(rubric => {
    const pairs = human
      .filter(h => h.runId === runId && h.rubric === rubric)
      .map(h => ({
        human: h,
        judge: judges.find(j => j.caseId === h.caseId && j.rubric === rubric),
      }))
      .filter((p): p is { human: HumanScore; judge: JudgeResult } => p.judge !== undefined);
    const unique = new Set(pairs.map(p => p.human.caseId));
    if (unique.size !== pairs.length)
      return {
        rubric,
        sampleCount: unique.size,
        kappa: null,
        status: 'blocked',
        reason: 'Repeated human labels for the same case require explicit adjudication before calibration',
      };
    if (unique.size < 10)
      return {
        rubric,
        sampleCount: unique.size,
        kappa: null,
        status: 'blocked',
        reason: 'At least ten distinct human-scored samples for this run/rubric are required',
      };
    const kappa = cohensKappa(
      pairs.map(p => p.human.label),
      pairs.map(p => p.judge.label),
    );
    return {
      rubric,
      sampleCount: unique.size,
      kappa,
      status: kappa === null ? 'blocked' : kappa >= 0.8 ? 'pass' : 'fail',
      reason:
        kappa === null
          ? 'Degenerate label distribution; agreement cannot be calibrated'
          : kappa >= 0.8
            ? 'Human/judge agreement meets Cohen kappa ≥0.8'
            : 'Judge/human agreement is below 0.8',
    };
  });
}
export function buildReport(options: {
  runId: string;
  fixtures: readonly EvalFixture[];
  measurements: readonly Measurement[];
  judges?: readonly JudgeResult[];
  humanScores?: readonly HumanScore[];
  domainReviews?: unknown[];
  evidence?: readonly QualityEvidence[];
  mode?: EvalReport['mode'];
}): EvalReport {
  const fixtures = z.array(FixtureSchema).parse(options.fixtures),
    corpusHash = hash(fixtures),
    issues = validateCorpus(fixtures),
    judges = [...(options.judges ?? [])],
    measurements = [...options.measurements],
    mode = options.mode ?? 'live';
  if (new Set(measurements.map(m => m.caseId)).size !== measurements.length) issues.push('Duplicate measurements can inflate metrics');
  for (const measurement of measurements) {
    const fixture = fixtures.find(f => f.id === measurement.caseId);
    if (!fixture || hash(fixture) !== measurement.fixtureHash) issues.push(`Fixture hash mismatch: ${measurement.caseId}`);
    if (measurement.output !== null && hash(measurement.output) !== measurement.outputHash)
      issues.push(`Output hash mismatch: ${measurement.caseId}`);
    if (mode !== 'test' && measurement.mode === 'test')
      issues.push(`Test measurements cannot satisfy a release gate: ${measurement.caseId}`);
    if (measurement.mode === 'untrusted_import')
      issues.push(`Untrusted file import is not verified runtime execution evidence: ${measurement.caseId}`);
  }
  for (const judge of judges) {
    const produced = measurements.find(m => m.caseId === judge.caseId && m.status === 'completed');
    if (!produced || produced.outputHash !== judge.outputHash || produced.model === judge.model)
      issues.push(`Judge provenance mismatch: ${judge.caseId}`);
  }
  if (new Set(judges.map(j => `${j.rubric}:${j.caseId}`)).size !== judges.length)
    issues.push('Duplicate judge outputs can inflate rubric metrics');
  const calibration = calibrate(
      options.runId,
      judges.filter(j => measurements.some(m => m.caseId === j.caseId && m.outputHash === j.outputHash && m.model !== j.model)),
      options.humanScores ?? [],
    ),
    metrics = aggregateMetrics(fixtures, measurements);
  for (const rubric of RUBRICS) {
    const suiteFixtures = fixtures.filter(f => f.suite === rubric),
      valid = judges.filter(
        j =>
          j.rubric === rubric &&
          suiteFixtures.some(f => f.id === j.caseId) &&
          measurements.some(m => m.caseId === j.caseId && m.status === 'completed' && m.outputHash === j.outputHash),
      );
    const rule = THRESHOLDS[`${rubric}.rubric`];
    if (!rule) throw new Error('Missing rubric threshold');
    const ready =
      calibration.find(c => c.rubric === rubric)?.status === 'pass' &&
      new Set(valid.map(j => j.caseId)).size === suiteFixtures.length &&
      valid.length === suiteFixtures.length;
    metrics.push(
      gate(
        `${rubric}.rubric`,
        ready ? valid.reduce((sum, j) => sum + j.score, 0) / valid.length : null,
        rule.threshold,
        rule.direction,
        'ratio',
        valid.length,
        ready ? null : 'Complete judged outputs and ≥10 human samples with κ≥0.8 required',
      ),
    );
  }
  const reviews = z.array(DomainReviewSchema).parse(options.domainReviews ?? []),
    reviewed = new Set(reviews.filter(r => r.corpusHash === corpusHash && r.decision === 'approved').flatMap(r => r.fixtureIds));
  const live = measurements.filter(m => m.mode === 'live' && m.status === 'completed'),
    unpriced = live.filter(m => m.costUsd === null),
    unpricedJudges = judges.filter(j => j.costUsd === null);
  const missingJudgeUsage = live.filter(
    m =>
      fixtures.some(f => f.id === m.caseId && ['planner', 'packets', 'brand'].includes(f.suite)) &&
      !judges.some(j => j.caseId === m.caseId && j.outputHash === m.outputHash),
  ).length;
  const costEvidence =
    (options.evidence ?? []).find(
      e => e.kind === 'field' && e.exitCode === 0 && Number(e.facts['calibrationMissions']) >= 10 && Number(e.facts['alarmUsd']) > 0,
    ) ||
    (options.evidence ?? []).find(
      e =>
        e.kind === 'performance' &&
        e.exitCode === 0 &&
        typeof e.facts['approvedBy'] === 'string' &&
        Number(e.facts['estimateUsd']) > 0 &&
        Number(e.facts['alarmUsd']) === Number(e.facts['estimateUsd']) * 2,
    );
  const runtimeCases = fixtures.filter(f => ['voice', 'honesty', 'scenario'].includes(f.suite));
  const externalGates: EvalReport['externalGates'] = [
    {
      id: 'corpus.domain_review',
      status: fixtures.every(f => reviewed.has(f.id)) ? 'pass' : 'blocked',
      reason: `${fixtures.filter(f => reviewed.has(f.id)).length}/${fixtures.length} synthetic fixtures approved by an identified human/domain reviewer; synthetic expectations are not field truth`,
    },
    {
      id: 'cost.actual_usage_and_pricing',
      status: live.length && unpriced.length === 0 && unpricedJudges.length === 0 && missingJudgeUsage === 0 ? 'pass' : 'blocked',
      reason: live.length
        ? `${unpriced.length} live runs and ${unpricedJudges.length} judge requests lack pricing; ${missingJudgeUsage} required judge requests lack complete usage records`
        : 'No live usage has been measured',
    },
    {
      id: 'cost.mission_alarm_calibration',
      status: costEvidence ? 'pass' : 'blocked',
      reason: costEvidence
        ? 'An actual ten-mission calibration or approved provisional 2× estimate alarm is evidenced'
        : 'Agent Design OD-A9 requires actual first-ten-mission calibration or a dated owner-approved provisional estimate and 2× alarm; “low hundreds” is not an executable limit',
    },
    {
      id: 'scenario.actual_runtime_evidence',
      status: runtimeCases.every(f =>
        measurements.some(m => m.caseId === f.id && m.mode === 'imported_runtime' && m.status === 'completed'),
      )
        ? 'pass'
        : 'blocked',
      reason: 'Voice15 + honesty12 + scenario25 require actual sandbox runtime ledger traces; model text is not execution',
    },
  ];
  for (const issue of issues) externalGates.push({ id: 'integrity', status: 'fail', reason: issue });
  const completed = measurements.some(m => m.status === 'completed'),
    failed =
      metrics.some(m => m.status === 'fail') || externalGates.some(g => g.status === 'fail') || calibration.some(c => c.status === 'fail');
  const status =
    !completed && issues.length === 0
      ? 'blocked'
      : failed
        ? 'fail'
        : metrics.some(m => m.status === 'blocked') ||
            externalGates.some(g => g.status === 'blocked') ||
            calibration.some(c => c.status === 'blocked')
          ? 'blocked'
          : 'pass';
  return EvalReportSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    createdAt: new Date().toISOString(),
    corpusHash,
    fixtureCount: fixtures.length,
    mode,
    measurements,
    judges,
    metrics,
    calibration,
    externalGates,
    status,
  });
}
export function compareReports(
  baseline: EvalReport,
  candidate: EvalReport,
): { passed: boolean; regressions: string[]; costDeltaUsd: number | null } {
  const regressions: string[] = [];
  if (baseline.corpusHash !== candidate.corpusHash) regressions.push('Corpus changed; establish a reviewed paired baseline');
  for (const prior of baseline.metrics) {
    const next = candidate.metrics.find(m => m.id === prior.id);
    if (!next) {
      regressions.push(`${prior.id}: metric missing`);
      continue;
    }
    if (next.threshold !== prior.threshold || next.direction !== prior.direction) regressions.push(`${prior.id}: threshold changed`);
    if (prior.value !== null && (next.value === null || (prior.direction === 'min' ? next.value < prior.value : next.value > prior.value)))
      regressions.push(`${prior.id}: score or latency regressed`);
  }
  const totalCost = (report: EvalReport) => {
    if (report.externalGates.find(g => g.id === 'cost.actual_usage_and_pricing')?.status !== 'pass') return null;
    const attempted = report.measurements.filter(m => m.status !== 'blocked'),
      allCosts = [...attempted.map(m => m.costUsd), ...report.judges.map(j => j.costUsd)];
    return allCosts.length && allCosts.every(c => c !== null) ? allCosts.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null;
  };
  const before = totalCost(baseline),
    after = totalCost(candidate);
  return {
    passed: regressions.length === 0 && candidate.status === 'pass',
    regressions,
    costDeltaUsd: before === null || after === null ? null : after - before,
  };
}
