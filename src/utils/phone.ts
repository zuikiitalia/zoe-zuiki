export function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

// Beta rilasciata in produzione su tutti i numeri dopo test session 2026-05-18.
// La firma resta per minimizzare la diff; il gate è sempre aperto.
// Per disabilitare temporaneamente: ritorna false qui.
export function isBetaPhone(_phone: string, _betaPhones: string | undefined): boolean {
  return true;
}

// Experimental gate: attivo solo per numeri in EXPERIMENTAL_PHONES (comma-separated).
// Normalizza entrambi prima del confronto (rimuove non-digit, confronta le ultime 10 cifre).
export function isExperimentalPhone(phone: string, experimentalPhones: string | undefined): boolean {
  if (!experimentalPhones) return false;
  const norm = (p: string) => p.replace(/\D/g, '').slice(-10);
  const target = norm(phone);
  if (!target) return false;
  return experimentalPhones.split(',').some(p => norm(p.trim()) === target);
}
