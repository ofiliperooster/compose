export const currentStatuses = ["ACTIVE", "DELAYED", "OVERDUE"];
export const cancelledStatuses = ["CANCELLED_BY_CUSTOMER", "CANCELLED_BY_SELLER", "CANCELLED_BY_ADMIN"];

type SubscriptionDates = {
  status?: string;
  accession_date?: number | string;
  date_next_charge?: number | string;
};

function hotmartDate(value: number | string | undefined) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 0 ? numeric * (numeric < 10_000_000_000 ? 1000 : 1) : NaN)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function subscriptionPeriod(subscription: SubscriptionDates) {
  return {
    startedAt: hotmartDate(subscription.accession_date),
    // For cancelled subscriptions Hotmart returns the last access date here.
    // end_accession_date records when cancellation was requested.
    expiresAt: hotmartDate(subscription.date_next_charge),
  };
}

export function isSubscriptionEligible(subscription: SubscriptionDates, today = new Date().toISOString().slice(0, 10)) {
  const status = subscription.status?.toUpperCase() ?? "";
  const { startedAt, expiresAt } = subscriptionPeriod(subscription);
  if (startedAt && startedAt > today) return false;
  if (cancelledStatuses.includes(status)) return expiresAt !== null && expiresAt >= today;
  return currentStatuses.includes(status) && (!expiresAt || expiresAt >= today);
}

export function compareSubscriptionPeriods(left: SubscriptionDates, right: SubscriptionDates) {
  const a = subscriptionPeriod(left);
  const b = subscriptionPeriod(right);
  return (b.expiresAt ?? "").localeCompare(a.expiresAt ?? "")
    || (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
}
