export function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

// Numeri beta hardcoded (fallback se BETA_PHONES non è configurato).
// Per estendere/cambiare senza redeploy: setta il secret BETA_PHONES su Cloudflare.
const DEFAULT_BETA_PHONES = ['393332603864'];

export function isBetaPhone(phone: string, betaPhones: string | undefined): boolean {
  const target = normalizePhone(phone);
  const fromEnv = (betaPhones ?? '')
    .split(',')
    .map((s) => normalizePhone(s.trim()))
    .filter((s) => s.length > 0);
  const allowed = fromEnv.length > 0 ? fromEnv : DEFAULT_BETA_PHONES;
  return allowed.includes(target);
}
