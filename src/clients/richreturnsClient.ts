import type { Env } from '../config';
import { logger } from '../utils/logger';

const BASE_URL = 'https://api.richcommerce.co/v1';

export type RichReturn = {
  rma: string;
  status: 'Pending' | 'Approved' | 'Shipped' | 'Received' | 'Resolved' | 'Rejected';
  createdAt: string;
  customer: { email: string; name: string };
  products: Array<{
    name: string;
    variantName: string;
    sku: string;
    returnItemQuantity: number;
    reason: string;
    resolution: string;
  }>;
  method: string;
  resolution: string;
  label?: { tracking: string; url: string };
  fees?: number;
  staffNotes?: string;
  rejectionNote?: string;
};

export async function getReturnByRMA(env: Env, rma: string): Promise<RichReturn | null> {
  const res = await fetch(`${BASE_URL}/returns/${encodeURIComponent(rma)}`, {
    headers: {
      'Authorization': `Bearer ${env.RICHRETURNS_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const body = await res.text();
    logger.error('richreturns_api_error', { rma, status: res.status, body: body.slice(0, 300) });
    throw new Error(`RichReturns API ${res.status}: ${body.slice(0, 200)}`);
  }

  const body = await res.json() as Record<string, unknown>;
  // L'API RichReturns wrappa sempre il risultato in { "return": {...} }
  const data = (body.return ?? body) as Record<string, unknown>;
  logger.info('richreturns_raw', { status: data.status, rma: data.rma, staffNotes: data.staffNotes });
  return mapRichReturn(data);
}

function mapRichReturn(raw: Record<string, unknown>): RichReturn {
  // Campi prodotti: RichReturns usa "Products" (capital P)
  const productList = (Array.isArray(raw.Products) ? raw.Products : Array.isArray(raw.returnItems) ? raw.returnItems : []) as Array<Record<string, unknown>>;
  const products = productList.map((item) => ({
    name: String(item.productName ?? item.name ?? ''),
    variantName: String(item.variantName ?? item.variantName ?? ''),
    sku: String(item.variantSku ?? item.sku ?? ''),
    returnItemQuantity: Number(item.returnItemQuantity ?? item.quantity ?? 1),
    reason: String(item.returnItemReason ?? item.returnReason ?? item.reason ?? ''),
    resolution: String(item.returnItemResolutionLabel ?? item.returnItemResolution ?? item.resolutionType ?? item.resolution ?? ''),
  }));

  const label = raw.labelTrackingNumber
    ? { tracking: String(raw.labelTrackingNumber), url: String(raw.labelUrl ?? raw.labelTrackingUrl ?? '') }
    : undefined;

  return {
    rma: String(raw.rma ?? raw.rmaNumber ?? ''),
    status: (raw.status ?? 'Pending') as RichReturn['status'],
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    customer: {
      email: String(raw.customerEmail ?? ''),
      name: `${raw.customerFirstName ?? ''} ${raw.customerLastName ?? ''}`.trim(),
    },
    products,
    method: String(raw.method ?? raw.returnMethod ?? ''),
    resolution: String(raw.resolutionType ?? raw.resolution ?? ''),
    label,
    fees: typeof raw.labelFeeAmount === 'number' ? raw.labelFeeAmount : typeof raw.restockingFeeAmount === 'number' ? raw.restockingFeeAmount : undefined,
    staffNotes: raw.staffNotes ? String(raw.staffNotes) : undefined,
    rejectionNote: raw.rejectionObservation ?? raw.rejectionNote
      ? String(raw.rejectionObservation ?? raw.rejectionNote)
      : undefined,
  };
}
