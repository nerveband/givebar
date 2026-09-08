import type { Database } from "bun:sqlite";

/**
 * Default-open authentication.
 *
 * Givebar ships with no credentials. A PIN only exists once an operator has
 * deliberately set one in Event Setup, so a blank or whitespace-only
 * `control_pin` means every surface and every endpoint is open. Enforcement
 * begins the moment a real PIN is stored, and never before.
 */
export function isControlPinConfigured(controlPin: string | null | undefined): boolean {
  return typeof controlPin === "string" && controlPin.trim() !== "";
}

export function isControlAuthorized(controlPin: string | null | undefined, providedPin: string): boolean {
  if (process.env.GIVEBAR_DISABLE_AUTH === "1") return true;
  if (!isControlPinConfigured(controlPin)) return true;
  return providedPin === controlPin;
}

/** Reads the PIN column directly so CSV export never materializes full state. */
export function readControlPin(db: Database): string {
  const row = db.query<{ control_pin: string }, []>(`SELECT control_pin FROM event_state WHERE id = 1`).get();
  return row ? row.control_pin : "";
}
