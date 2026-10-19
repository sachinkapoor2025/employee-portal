import {
  displayRateOrUnset,
  formatUsdRate,
  parseUsdRateInput,
  rateSourceLabel,
  resolvedPreviewLine,
} from "./costRates";

test("blank rate input is unset, not zero", () => {
  expect(parseUsdRateInput("").value).toBeNull();
  expect(parseUsdRateInput("  ").value).toBeNull();
  expect(parseUsdRateInput(null).value).toBeNull();
});

test("rejects zero, negative, non-finite, and extra decimals", () => {
  expect(parseUsdRateInput("0").ok).toBe(false);
  expect(parseUsdRateInput("-1").ok).toBe(false);
  expect(parseUsdRateInput("1.234").ok).toBe(false);
  expect(parseUsdRateInput("abc").ok).toBe(false);
});

test("accepts two-decimal USD rates", () => {
  expect(parseUsdRateInput("2.25").value).toBe(2.25);
});

test("blank display is distinct from zero", () => {
  expect(formatUsdRate(null)).toBe("");
  expect(displayRateOrUnset(null)).toBe("Not configured");
  expect(displayRateOrUnset(2.25)).toBe("$2.25");
});

test("source labels", () => {
  expect(rateSourceLabel("EMPLOYEE")).toBe("Employee");
  expect(rateSourceLabel("DESIGNATION")).toBe("Designation");
  expect(rateSourceLabel(null)).toBe("Not configured");
});

test("resolved preview uses employee then designation", () => {
  expect(
    resolvedPreviewLine({ rate: 2.25, source: "EMPLOYEE" })
  ).toEqual({ text: "$2.25", source: "Employee" });
  expect(
    resolvedPreviewLine({ rate: 3, source: "DESIGNATION" })
  ).toEqual({ text: "$3.00", source: "Designation" });
  expect(resolvedPreviewLine({ rate: null, source: null }).text).toBe(
    "Not configured"
  );
});
