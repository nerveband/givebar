// Donor-name matching across sources that spell people differently ("Dr. Iyad Barakat",
// "Household of Iyad Barakat", "Iyad & Reem Barakat"). Everything is compared on person keys:
// a name is split on couple separators and each half is reduced to lowercase ASCII words with
// titles and honorifics removed.

const TITLES: Record<string, true> = { dr: true, mr: true, mrs: true, ms: true, mx: true, sr: true, br: true, sister: true, brother: true, imam: true, shaykh: true, sheikh: true, hajji: true, haji: true, prof: true, professor: true, md: true, phd: true, esq: true, jr: true, ii: true, iii: true, the: true, household: true, of: true, family: true, and: true };

export function asciiFold(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`]/g, "'");
}

/** Lowercase ASCII words of a single person's name, titles dropped. */
export function nameWords(value: string): string[] {
  return asciiFold(value).toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).map(word => word.replace(/^[-']+|[-']+$/g, "")).filter(word => word && !TITLES[word]);
}

/** Split "Mehreen and Farhan Siddiqui" or "Absar Ahmed/Rabah Masood" into individual person names, sharing a trailing surname when one half has none. */
export function personNames(value: string): string[] {
  const parts = asciiFold(value).split(/\s*(?:&|\band\b|\+|\/|,)\s*/i).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return parts;
  const lastWords = nameWords(parts[parts.length - 1]);
  const surname = lastWords.length > 1 ? lastWords[lastWords.length - 1] : "";
  return parts.map(part => nameWords(part).length === 1 && surname ? `${part} ${surname}` : part);
}

/** Canonical key of one person: "first last" (first and last word). "iyad barakat". */
export function personKey(value: string): string {
  const words = nameWords(value);
  if (!words.length) return "";
  if (words.length === 1) return words[0];
  return `${words[0]} ${words[words.length - 1]}`;
}

/** Every person key a donor label denotes, plus the whole-label key. */
export function nameKeys(value: string): string[] {
  const keys = new Set<string>();
  for (const person of personNames(value)) { const key = personKey(person); if (key) keys.add(key); }
  const whole = nameWords(value).join(" ");
  if (whole) keys.add(whole);
  return [...keys];
}

/** Household key: the surname shared by the label, used to fold "Iyad Barakat" and "Reem Barakat" gifts into one row when first names differ but the ledger shows the same household. */
export function surnameKey(value: string): string {
  const words = nameWords(personNames(value)[0] || value);
  return words.length ? words[words.length - 1] : "";
}

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Index rows by every person key so a lookup by any spelling of the donor finds them. */
export class NameIndex<T> {
  private byKey = new Map<string, T[]>();
  private byEmail = new Map<string, T[]>();
  add(label: string, row: T, email?: string): void {
    for (const key of nameKeys(label)) {
      const list = this.byKey.get(key) || [];
      if (!list.includes(row)) list.push(row);
      this.byKey.set(key, list);
    }
    const mail = normalizeEmail(email);
    if (mail) { const list = this.byEmail.get(mail) || []; if (!list.includes(row)) list.push(row); this.byEmail.set(mail, list); }
  }
  find(label: string, email?: string): T[] {
    const found: T[] = [];
    const mail = normalizeEmail(email);
    if (mail) for (const row of this.byEmail.get(mail) || []) if (!found.includes(row)) found.push(row);
    for (const key of nameKeys(label)) for (const row of this.byKey.get(key) || []) if (!found.includes(row)) found.push(row);
    return found;
  }
}
