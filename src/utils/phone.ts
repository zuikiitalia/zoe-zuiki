export function normalizePhone(p: string): string {
  return p.replace(/\D/g, '');
}

export function isBetaPhone(phone: string, betaPhones: string | undefined): boolean {
  if (!betaPhones || !betaPhones.trim()) return false;
  const target = normalizePhone(phone);
  const allowed = betaPhones
    .split(',')
    .map((s) => normalizePhone(s.trim()))
    .filter((s) => s.length > 0);
  return allowed.includes(target);
}
