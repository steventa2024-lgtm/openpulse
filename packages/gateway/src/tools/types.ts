/**
 * - low: read-only or trivially reversible.
 * - medium: changes state in a limited, expected way.
 * - high: destructive, privileged, or hard to reverse.
 * - blocked: catastrophic; never executed.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';

export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}
