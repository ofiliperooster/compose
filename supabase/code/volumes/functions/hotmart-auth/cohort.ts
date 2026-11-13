export type CohortMatch = {
  cohortNumber: number;
  cohortCode: string;
  planName: string;
  cohortName: string | null;
};

const COHORT_PATTERNS = [
  /(?:^|[^A-Z0-9])T\s*[-_]?\s*(\d{1,4})(?:$|[^0-9])/i,
  /\bturma\s+(\d{1,4})\b/i,
];

export function extractHotmartCohort(payload: unknown): CohortMatch | null {
  const namedCohortNumber = (name: string) => {
    const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    let hash = 0x811c9dc5;
    for (let index = 0; index < normalized.length; index += 1) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    // Reserve a high, stable numeric range for name-only cohorts. Existing numbered
    // cohorts and database joins can keep using cohort_number unchanged.
    return 1_000_000_000 + ((hash >>> 0) % 1_000_000_000);
  };
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
        const match = COHORT_PATTERNS.map((pattern) => planName.match(pattern)).find(Boolean);
        if (match) {
          const cohortNumber = Number(match[1]);
          return { cohortNumber, cohortCode: `T${cohortNumber}`, planName, cohortName: null };
        }
        if (planName.trim()) {
          const cohortNumber = namedCohortNumber(planName);
          return { cohortNumber, cohortCode: `N${cohortNumber}`, planName, cohortName: planName.trim() };
        }
      }
    }
    for (const nested of Object.values(record)) { const match = inspect(nested); if (match) return match; }
    return null;
  }
  return inspect(payload);
}
