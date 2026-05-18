import type { Env } from '../config';
import { getProductByHandleEnriched } from './shopifyClient';
import { checkBarcodeAvailability, type StoreStock } from './siacloudClient';

export interface AvailabilityResult {
  found: boolean;
  product?: {
    title: string;
    handle: string;
    url: string | null;
    product_type: string;
  };
  // Variant resolved
  variant?: {
    options: Record<string, string>;
    sku: string;
    barcode: string | null;
    online_available: boolean;
    online_qty: number | null;
    inventory_policy: string;
  };
  ecom_qty?: number;
  total_nationwide?: number;
  stores?: StoreStock[];
  // Ambiguous: multiple variants match color/size
  needs_clarification?: boolean;
  available_colors?: string[];
  available_sizes?: string[];
  clarification_note?: string;
  // Product found but barcode missing
  error?: string;
}

function matchOption(value: string, query: string): boolean {
  const v = value.toLowerCase();
  const q = query.toLowerCase().trim();
  return v === q || v.includes(q) || q.includes(v);
}

export async function checkAvailability(
  env: Env,
  handleOrSku: string,
  size?: string,
  color?: string,
  location?: string
): Promise<AvailabilityResult> {
  const product = await getProductByHandleEnriched(env, handleOrSku);
  if (!product.found || !product.variants) {
    return { found: false };
  }

  const productInfo = {
    title: product.title!,
    handle: product.handle!,
    url: product.url ?? null,
    product_type: product.product_type ?? '',
  };

  let candidates = product.variants;

  // Filter by color
  if (color) {
    const colorMatches = candidates.filter((v) => {
      const varColor = v.options['Colore'] ?? v.options['Color'] ?? '';
      return matchOption(varColor, color);
    });
    if (colorMatches.length === 0) {
      return {
        found: true,
        product: productInfo,
        needs_clarification: true,
        available_colors: [...new Set(
          candidates.map((v) => v.options['Colore'] ?? v.options['Color'] ?? '').filter(Boolean)
        )],
        clarification_note: `Colore "${color}" non trovato. Colori disponibili indicati sopra.`,
      };
    }
    candidates = colorMatches;
  }

  // Filter by size
  if (size) {
    const sizeMatches = candidates.filter((v) => {
      const varSize = v.options['Taglia'] ?? v.options['Size'] ?? '';
      return matchOption(varSize, size);
    });
    if (sizeMatches.length === 0) {
      return {
        found: true,
        product: productInfo,
        needs_clarification: true,
        available_sizes: [...new Set(
          candidates.map((v) => v.options['Taglia'] ?? v.options['Size'] ?? '').filter(Boolean)
        )],
        available_colors: color
          ? undefined
          : [...new Set(candidates.map((v) => v.options['Colore'] ?? '').filter(Boolean))],
        clarification_note: `Taglia "${size}" non trovata. Taglie disponibili indicate sopra.`,
      };
    }
    candidates = sizeMatches;
  }

  // If still multiple candidates (e.g. no color specified and multiple colors), ask
  if (candidates.length > 1 && !color && !size) {
    return {
      found: true,
      product: productInfo,
      needs_clarification: true,
      available_colors: [...new Set(
        candidates.map((v) => v.options['Colore'] ?? v.options['Color'] ?? '').filter(Boolean)
      )],
      available_sizes: [...new Set(
        candidates.map((v) => v.options['Taglia'] ?? v.options['Size'] ?? '').filter(Boolean)
      )],
      clarification_note: 'Specifica taglia e/o colore per identificare la variante esatta.',
    };
  }

  // If still multiple after color+size filter (e.g. multiple matching shades), pick first
  const variant = candidates[0]!;
  const barcode = variant.barcode;

  if (!barcode) {
    return {
      found: true,
      product: productInfo,
      variant: {
        options: variant.options,
        sku: variant.sku,
        barcode: null,
        online_available: variant.available,
        online_qty: variant.inventory,
        inventory_policy: variant.inventory_policy,
      },
      error: 'barcode_missing',
    };
  }

  const avail = await checkBarcodeAvailability(barcode);

  // Filter stores by location if given
  let stores = avail.stores;
  if (location) {
    const loc = location.toLowerCase().trim();
    stores = stores.filter(
      (s) =>
        s.province.toLowerCase().includes(loc) ||
        s.region.toLowerCase().includes(loc) ||
        s.name.toLowerCase().includes(loc)
    );
  }

  return {
    found: true,
    product: productInfo,
    variant: {
      options: variant.options,
      sku: variant.sku,
      barcode,
      online_available: variant.available,
      online_qty: variant.inventory,
      inventory_policy: variant.inventory_policy,
    },
    ecom_qty: avail.ecom_qty,
    total_nationwide: avail.total,
    stores,
  };
}
