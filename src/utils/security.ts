async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyShopifyHmac(params: URLSearchParams, secret: string): Promise<boolean> {
  const received = params.get('hmac');
  if (!received) return false;
  const pairs: [string, string][] = [];
  params.forEach((value, key) => {
    if (key !== 'hmac' && key !== 'signature') pairs.push([key, value]);
  });
  pairs.sort(([a], [b]) => a.localeCompare(b));
  const message = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const expected = await hmacSha256Hex(secret, message);
  return timingSafeEqual(expected, received.toLowerCase());
}

export function verifySpokiWebhook(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const url = new URL(request.url);
  const qs = url.searchParams.get('secret');
  const header = request.headers.get('x-webhook-secret');
  const ok = (v: string | null) => v !== null && timingSafeEqual(v, secret);
  return ok(qs) || ok(header);
}

export function generateRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
