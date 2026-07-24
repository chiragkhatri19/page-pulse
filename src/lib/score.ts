import type { CheckResult, Pillar } from './analyze.js';

export interface PillarScore {
  score: number;
  earned: number;
  possible: number;
  grade: Grade;
  failedChecks: number;
}

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ScoreResult {
  overall: number;
  grade: Grade;
  pillars: Record<Pillar, PillarScore>;
  recommendations: Recommendation[];
}

export interface Recommendation {
  checkId: string;
  pillar: Pillar;
  title: string;
  detail: string;
  impact: 'high' | 'medium' | 'low';
}

export const PILLARS: Pillar[] = ['seo', 'accessibility', 'performance', 'security'];

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

const impactFor = (weight: number): Recommendation['impact'] =>
  weight >= 7 ? 'high' : weight >= 4 ? 'medium' : 'low';

/**
 * Scoring is pure and deterministic: same checks in, same numbers out. Keeping
 * it free of I/O is what makes it cheap to unit-test exhaustively, and it means
 * a cached result and a fresh result are byte-identical for identical input.
 */
export function score(checks: CheckResult[]): ScoreResult {
  const pillars = {} as Record<Pillar, PillarScore>;

  for (const pillar of PILLARS) {
    const subset = checks.filter((c) => c.pillar === pillar);
    const possible = subset.reduce((sum, c) => sum + c.weight, 0);
    const earned = subset.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
    const value = possible === 0 ? 100 : Math.round((earned / possible) * 100);
    pillars[pillar] = {
      score: value,
      earned,
      possible,
      grade: gradeFor(value),
      failedChecks: subset.filter((c) => !c.passed).length,
    };
  }

  const possible = checks.reduce((sum, c) => sum + c.weight, 0);
  const earned = checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0);
  const overall = possible === 0 ? 100 : Math.round((earned / possible) * 100);

  const recommendations: Recommendation[] = checks
    .filter((c) => !c.passed)
    .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
    .map((c) => ({
      checkId: c.id,
      pillar: c.pillar,
      title: c.label,
      detail: c.detail,
      impact: impactFor(c.weight),
    }));

  return { overall, grade: gradeFor(overall), pillars, recommendations };
}
