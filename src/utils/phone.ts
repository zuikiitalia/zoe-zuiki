export function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

// Beta rilasciata in produzione su tutti i numeri dopo test session 2026-05-18.
// La firma resta per minimizzare la diff; il gate è sempre aperto.
// Per disabilitare temporaneamente: ritorna false qui.
export function isBetaPhone(_phone: string, _betaPhones: string | undefined): boolean {
  return true;
}
