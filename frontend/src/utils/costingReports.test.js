import {
  moneyUsd,
  hoursLabel,
  costStatusLabel,
  defaultCostingRange,
  companyDateKey,
  mergeCostingPages,
  confirmedCostHeadline,
  withPersistedTruncation,
  INCOMPLETE_COSTING_TOTALS,
  INCOMPLETE_REPORT_TITLE,
  INCOMPLETE_TOTAL_DISPLAY,
} from "./costingReports";

test("formats money and hours without inventing values", () => {
  expect(moneyUsd(6.75)).toBe("$6.75");
  expect(moneyUsd(null)).toBe("—");
  expect(hoursLabel(3)).toBe("3");
  expect(hoursLabel(null)).toBe("—");
});

test("labels missing-rate separately from missing cost records", () => {
  expect(costStatusLabel("MISSING_RATE")).toBe("Missing rate");
  expect(costStatusLabel("MISSING_COST_RECORD")).toBe("Missing cost record");
  expect(costStatusLabel("UNPRICED_LEGACY")).toBe("Unpriced legacy");
});

test("default range is 30 IST days inclusive", () => {
  const range = defaultCostingRange();
  expect(range.to).toBe(companyDateKey());
  expect(range.from < range.to || range.from === range.to).toBe(true);
});

test("mergeCostingPages resets or skips duplicate assignment identities", () => {
  const first = [{ taskId: "t1", email: "rahul@mydgv.com", costStatus: "PENDING_REVIEW" }];
  const second = [
    { taskId: "t1", email: "rahul@mydgv.com", costStatus: "COSTED" },
    { taskId: "t2", email: "rahul@mydgv.com", costStatus: "COSTED" },
  ];
  const paged = mergeCostingPages(first, second);
  expect(paged).toHaveLength(2);
  expect(paged[0].costStatus).toBe("PENDING_REVIEW");
  expect(paged[1].taskId).toBe("t2");
  const refreshed = mergeCostingPages(first, second, { reset: true });
  expect(refreshed).toHaveLength(2);
  expect(refreshed[0].costStatus).toBe("COSTED");
  expect(INCOMPLETE_COSTING_TOTALS).toMatch(/not a complete or authoritative cost/);
  expect(INCOMPLETE_REPORT_TITLE).toMatch(/not authoritative/);
});

test("truncated confirmed cost is not presented as a dollar total", () => {
  expect(confirmedCostHeadline(true, 6.75)).toBe(INCOMPLETE_TOTAL_DISPLAY);
  expect(confirmedCostHeadline(false, 6.75)).toBe("$6.75");
});

test("paging cannot clear a truncated collection flag", () => {
  const paged = withPersistedTruncation(
    { truncated: true, summary: { confirmedCostUsd: 6.75 } },
    { truncated: false, summary: { confirmedCostUsd: 6.75 } },
    { paged: true }
  );
  expect(paged.truncated).toBe(true);
  const refreshed = withPersistedTruncation(
    { truncated: true },
    { truncated: false, summary: { confirmedCostUsd: 1 } },
    { paged: false }
  );
  expect(refreshed.truncated).toBe(false);
});
