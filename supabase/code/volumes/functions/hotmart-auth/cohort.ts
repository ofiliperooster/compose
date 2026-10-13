export type CohortMatch = {
  cohortNumber: number;
  cohortCode: string;
  planName: string;
};

const COHORT_PATTERN = /(?:^|[^A-Z0-9])T\s*[-_]?\s*(\d{1,4})(?:$|[^0-9])/i;

export function extractHotmartCohort(payload: unknown): CohortMatch | null {
  const visited = new Set<object>();
  function inspect(value: unknown): CohortMatch | null {
    if (!value || typeof value !== 'object') return null;
    if (visited.has(value as object)) return null;
    visited.add(value as object);
    if (Array.isArray(value)) {
      for (const item of value) { const match = inspect(item); if (match) return match; }
      return null;
    }
    const record = value as Record<string, unknown>;
    const plan = record.plan;
    if (plan && typeof plan === 'object') {
      const planName = (plan as Record<string, unknown>).name;
      if (typeof planName === 'string') {
        const match = planName.match(COHORT_PATTERN);
        if (match) {
          const cohortNumber = Number(match[1]);
          return { cohortNumber, cohortCode: `T${cohortNumber}`, planName };
        }
      }
    }
    for (const nested of Object.values(record)) { const match = inspect(nested); if (match) return match; }
    return null;
  }
  return inspect(payload);
}
