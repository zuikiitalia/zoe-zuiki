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

  const data = await res.json() as Record<string, unknown>;
  return mapRichReturn(data);
}

function mapRichReturn(raw: Record<string, unknown>): RichReturn {
  // Map dei campi API RichReturns verso il tipo interno
  const products = Array.isArray(raw.returnItems)
    ? (raw.returnItems as Array<Record<string, unknown>>).map((item) => ({
        name: String(item.productName ?? item.name ?? ''),
        variantName: String(item.variantName ?? item.variant ?? ''),
        sku: String(item.sku ?? ''),
        returnItemQuantity: Number(item.returnItemQuantity ?? item.quantity ?? 1),
        reason: String(item.returnReason ?? item.reason ?? ''),
        resolution: String(item.resolutionType ?? item.resolution ?? ''),
      }))
    : [];

  const labelRaw = raw.shippingLabel as Record<string, unknown> | undefined;
  const label = labelRaw?.trackingNumber
    ? { tracking: String(labelRaw.trackingNumber), url: String(labelRaw.url ?? '') }
    : undefined;

  return {
    rma: String(raw.rmaNumber ?? raw.rma ?? ''),
    status: (raw.status ?? 'Pending') as RichReturn['status'],
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    customer: {
      email: String((raw.customer as Record<string, unknown> | undefined)?.email ?? raw.customerEmail ?? ''),
      name: String((raw.customer as Record<string, unknown> | undefined)?.name ?? raw.customerName ?? ''),
    },
    products,
    method: String(raw.returnMethod ?? raw.method ?? ''),
    resolution: String(raw.resolutionType ?? raw.resolution ?? ''),
    label,
    fees: typeof raw.fees === 'number' ? raw.fees : undefined,
    staffNotes: raw.staffNotes ?? raw.staff_notes ?? raw.internalNotes ?? raw.internal_notes
      ? String(raw.staffNotes ?? raw.staff_notes ?? raw.internalNotes ?? raw.internal_notes)
      : undefined,
    rejectionNote: raw.rejectionObservation ?? raw.rejection_observation ?? raw.rejectionNote ?? raw.rejection_note
      ? String(raw.rejectionObservation ?? raw.rejection_observation ?? raw.rejectionNote ?? raw.rejection_note)
      : undefined,
  };
}
