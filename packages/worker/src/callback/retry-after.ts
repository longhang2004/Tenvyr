export function parseRetryAfterDeltaSeconds(
  value: string | null,
  maximumSeconds: number,
): number | undefined {
  if (value === null || !/^[0-9]+$/.test(value)) return undefined;

  const digits = value.replace(/^0+(?=\d)/, "");
  const boundedMaximum = Math.min(
    Math.floor(maximumSeconds),
    Number.MAX_SAFE_INTEGER,
  );
  const maximumDigits = String(boundedMaximum);
  if (
    digits.length > maximumDigits.length ||
    (digits.length === maximumDigits.length && digits > maximumDigits)
  ) {
    return maximumSeconds;
  }
  return Number(digits);
}
