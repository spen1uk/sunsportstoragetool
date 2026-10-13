import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Normalize to E.164 (US default). Returns null if not a plausible number. Original is stored separately by callers. */
export function normalizePhone(input: string, defaultCountry: 'US' = 'US'): string | null {
  const p = parsePhoneNumberFromString(input.trim(), defaultCountry);
  return p && p.isValid() ? p.number : null;
}
