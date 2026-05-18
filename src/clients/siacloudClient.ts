import { logger } from '../utils/logger';
import { getSiacloudStore } from '../data/siacloudStoreCodes';

// Endpoint pubblico Siacloud (no auth richiesta, verificato 2026-05-11).
// Restituisce la disponibilita' di un barcode in tutti i ~160 negozi Zuiki.
const SIACLOUD_BASE = 'https://shopifyzuikiv1.siacloud.com/admin';

interface SiacloudResponse {
  status: string;
  code: number;
  statusText?: string;
  data?: Record<string, { total: number; stores: Record<string, number> }>;
}

export interface StoreStock {
  code: string;
  name: string;
  region: string;
  province: string;
  qty: number;
}

export interface BarcodeAvailability {
  found: boolean;
  barcode: string;
  total: number;
  ecom_qty: number;
  stores: StoreStock[];
}

/**
 * Chiama Siacloud per la disponibilita' di un barcode in tutti i negozi.
 * Filtra:
 *  - giacenze <= 0 (alcuni codici hanno -1 per discrepanze, vanno trattati come 0)
 *  - codice "ECOM" (magazzino e-commerce centrale, non e' un negozio fisico)
 * Ordina per quantita' decrescente.
 */
export async function checkBarcodeAvailability(barcode: string): Promise<BarcodeAvailability> {
  const url = `${SIACLOUD_BASE}/siacloud_get_barcode_availability_in_store/${encodeURIComponent(barcode)}`;

  let json: SiacloudResponse;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      logger.warn('siacloud_inventory_http_error', { status: res.status, barcode });
      return { found: false, barcode, total: 0, ecom_qty: 0, stores: [] };
    }
    json = (await res.json()) as SiacloudResponse;
  } catch (err) {
    logger.error('siacloud_inventory_fetch_failed', {
      error: err instanceof Error ? err.message : String(err),
      barcode,
    });
    return { found: false, barcode, total: 0, ecom_qty: 0, stores: [] };
  }

  if (json.status !== 'OK' || !json.data || !json.data[barcode]) {
    logger.info('siacloud_inventory_empty', { barcode, status: json.status });
    return { found: false, barcode, total: 0, ecom_qty: 0, stores: [] };
  }

  const entry = json.data[barcode];
  let ecomQty = 0;
  const stores: StoreStock[] = [];
  for (const [code, qty] of Object.entries(entry.stores)) {
    if (code === 'ECOM') { ecomQty = Math.max(0, qty); continue; }
    if (qty <= 0) continue;
    const meta = getSiacloudStore(code);
    stores.push({
      code,
      name: meta?.name ?? code,
      region: meta?.region ?? '',
      province: meta?.province ?? '',
      qty,
    });
  }
  stores.sort((a, b) => b.qty - a.qty);

  return {
    found: true,
    barcode,
    total: entry.total,
    ecom_qty: ecomQty,
    stores,
  };
}
