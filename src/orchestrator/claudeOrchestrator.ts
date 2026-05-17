import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../config';
import {
  CLAUDE_MODEL,
  CLAUDE_MAX_TOKENS,
  MAX_TOOL_ITERATIONS,
} from '../config';
import { SYSTEM_PROMPT } from '../prompts/systemPrompt';
import { TOOL_DEFINITIONS } from './toolDefinitions';
import {
  getOrderByNameAndEmail,
  searchProducts,
  getProductByHandle,
  ShopifyNotInstalledError,
} from '../clients/shopifyClient';
import { createSpokiTicket } from '../clients/spokiClient';
import { getReturnByRMA } from '../clients/richreturnsClient';
import { checkBarcodeAvailability } from '../clients/siacloudClient';
import { SIACLOUD_STORES } from '../data/siacloudStoreCodes';
import {
  computeImageEmbeddingFashionCLIP,
  computeTextEmbeddingFashionCLIP,
  findSimilarProducts,
} from '../clients/vectorizeClient';
import { logger } from '../utils/logger';
import type { StoredMessage } from '../storage/kvStore';
import { getCategoryName } from '../data/skuSuffixes';
import { insertApiCall, insertToolCall, upsertConversation } from '../analytics/db';
import type { ApiCallData } from '../analytics/db';

const STORES_CDN_URL = 'https://cdn.shopify.com/s/files/1/0624/0642/6862/files/stores.json?v=1774869600';

interface CdnStore {
  r: string; p: string; n: string; t: string;
  a: string; c: string; tel: number;
  la: string; lo: string;
  hw: string; hs: string; hd: string;
  m: string;
}

function parseHour(s: string): number {
  // "9.00" → 9.0, "21.00" → 21.0, "CHIUSO" / "" → -1
  if (!s || s.toUpperCase().includes('CHIUSO')) return -1;
  return parseFloat(s.replace(',', '.'));
}

function isOpenNow(hw: string, hs: string, hd: string): { open: boolean; closes_at: string | null } {
  const now = new Date();
  const rome = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const weekday = rome.find(p => p.type === 'weekday')?.value?.toLowerCase() ?? '';
  const h = parseInt(rome.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(rome.find(p => p.type === 'minute')?.value ?? '0', 10);
  const current = h + m / 60;

  const isSun = weekday.startsWith('dom');
  const isSat = weekday.startsWith('sab');
  const hoursStr = isSun ? hd : isSat ? hs : hw;
  const parts = hoursStr.split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { open: false, closes_at: null };
  const openH = parseHour(parts[0]);
  const closeH = parseHour(parts[1]);
  if (openH < 0 || closeH < 0) return { open: false, closes_at: null };
  const isOpen = current >= openH && current < closeH;
  return { open: isOpen, closes_at: isOpen ? parts[1].trim() : null };
}

async function searchStores(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const city = (input.city as string | undefined)?.toLowerCase().trim();
  const region = (input.region as string | undefined)?.toLowerCase().trim();
  const query = (input.query as string | undefined)?.toLowerCase().trim();

  let stores: CdnStore[] = [];
  try {
    const res = await fetch(STORES_CDN_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`CDN ${res.status}`);
    stores = await res.json() as CdnStore[];
  } catch {
    return { error: 'stores_fetch_failed', found: 0, stores: [] };
  }

  const matches = stores.filter((s) => {
    if (city && !s.c.toLowerCase().includes(city) && !s.n.toLowerCase().includes(city)) return false;
    if (region && !s.r.toLowerCase().includes(region) && !s.p.toLowerCase().includes(region)) return false;
    if (query) {
      const hay = `${s.n} ${s.a} ${s.c} ${s.p} ${s.r}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }).slice(0, 15);

  return {
    total_in_catalog: stores.length,
    found: matches.length,
    stores: matches.map((s) => {
      const { open, closes_at } = isOpenNow(s.hw, s.hs, s.hd);
      return {
        name: s.n,
        type: s.t,
        region: s.r,
        province: s.p,
        city: s.c,
        address: s.a,
        tel: String(s.tel),
        hours_weekday: s.hw,
        hours_saturday: s.hs,
        hours_sunday: s.hd,
        maps_url: s.m,
        is_open_now: open,
        closes_at,
        coords: { lat: s.la, lng: s.lo },
      };
    }),
  };
}

// Normalizza un nome negozio per fuzzy match: lowercase, rimuove accenti,
// abbreviazioni "C.C.", "S.C.", "C/C", punteggiatura, spazi multipli.
function normalizeStoreName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\bc[.\s/]?c\.?\b/g, '')   // "C.C.", "C/C", "C C"
    .replace(/\bs[.\s]?c\.?\b/g, '')    // "S.C."
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Score di similarità tra query del cliente e nome negozio.
// Restituisce 0..1 (1 = match esatto/perfetto).
function storeNameScore(query: string, storeName: string): number {
  const q = normalizeStoreName(query);
  const n = normalizeStoreName(storeName);
  if (!q || !n) return 0;
  if (n.includes(q)) return 1;            // query è dentro il nome (esatto)
  if (q.includes(n)) return 0.9;          // nome è dentro la query (cliente più generico)
  // Match per token: ogni parola della query deve avere un prefisso significativo in qualche parola del nome.
  const qTokens = q.split(' ').filter(t => t.length >= 4);
  const nTokens = n.split(' ');
  if (qTokens.length === 0) return 0;
  let matched = 0;
  for (const qt of qTokens) {
    const prefix = qt.slice(0, Math.max(4, qt.length - 2)); // tollera ultimo 1-2 char (typo)
    if (nTokens.some(nt => nt.startsWith(prefix) || qt.startsWith(nt.slice(0, prefix.length)))) {
      matched++;
    }
  }
  return matched / qTokens.length * 0.85; // max 0.85 per match parziale
}

// Trova i negozi che plausibilmente corrispondono alla query del cliente.
// Restituisce top match con score >= 0.6.
function findStoreCandidates(query: string, maxResults = 5): Array<{ code: string; name: string; region: string; province: string; score: number }> {
  return SIACLOUD_STORES
    .map(s => ({ ...s, score: storeNameScore(query, s.name) }))
    .filter(s => s.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

async function executeTool(
  env: Env,
  phone: string,
  name: string,
  input: Record<string, unknown>,
  clipEmbedding?: number[] | null,
  convId?: string
): Promise<string> {
  try {
    switch (name) {
      case 'get_order_by_number_and_email': {
        const res = await getOrderByNameAndEmail(
          env,
          String(input.order_number ?? ''),
          String(input.email ?? '')
        );
        logger.info('order_lookup_result', {
          found: res.found,
          note: (res as unknown as Record<string, unknown>).note ?? null,
          rma_number: res.rma_number ?? null,
          has_richreturns_key: !!env.RICHRETURNS_API_KEY,
        }, phone);
        if (res.found && res.rma_number && env.RICHRETURNS_API_KEY) {
          const returnData = await getReturnByRMA(env, res.rma_number).catch((e) => {
            logger.error('richreturns_fetch_failed', { rma: res.rma_number, error: String(e) }, phone);
            return null;
          });
          logger.info('richreturns_result', { rma: res.rma_number, found: !!returnData, status: returnData?.status ?? null }, phone);
          return JSON.stringify({ ...res, return_status: returnData ?? undefined });
        }
        return JSON.stringify(res);
      }
      case 'search_products': {
        const res = await searchProducts(env, String(input.query ?? ''));
        return JSON.stringify(res);
      }
      case 'get_product_by_handle': {
        const res = await getProductByHandle(env, String(input.handle ?? ''));
        return JSON.stringify(res);
      }
      case 'search_stores': {
        return JSON.stringify(await searchStores(input));
      }
      case 'check_store_availability': {
        const barcode = String(input.barcode ?? '').trim();
        if (!barcode) return JSON.stringify({ error: 'missing_barcode' });
        const regionFilter = (input.region as string | undefined)?.toLowerCase().trim();
        const provinceFilter = (input.province as string | undefined)?.toLowerCase().trim();
        const nameQueryRaw = (input.store_name as string | undefined)?.trim();
        const maxResults = Math.max(1, Math.min(50, Number(input.max_results) || 15));

        // Fuzzy match del nome negozio: l'utente può scrivere "Franciacorte" ma il
        // negozio si chiama "Franciacorta Outlet Village". Calcoliamo i candidati
        // sulla mappa completa dei 146 negozi Siacloud.
        let resolvedCodes: Set<string> | null = null;
        let candidates: Array<{ code: string; name: string; region: string; province: string; score: number }> = [];
        let ambiguous = false;
        if (nameQueryRaw) {
          candidates = findStoreCandidates(nameQueryRaw, 5);
          if (candidates.length === 0) {
            // Nessun match plausibile: probabile typo grosso. Restituiamo errore di match.
            logger.info('store_name_no_match', { query: nameQueryRaw }, phone);
            return JSON.stringify({
              error: 'store_name_not_recognized',
              query: nameQueryRaw,
              message: `Non riconosco nessun negozio Zuiki con un nome simile a "${nameQueryRaw}". Chiedi al cliente di precisare città o nome più completo.`,
            });
          }
          // Esattamente 1 candidato OR il top è molto più forte del secondo → usa quello.
          const top = candidates[0]!;
          const second = candidates[1];
          if (!second || (top.score - second.score) >= 0.2 || top.score >= 0.95) {
            resolvedCodes = new Set([top.code]);
          } else {
            // Ambiguo: 2+ candidati con score simile. Restituisci la lista per chiedere conferma.
            ambiguous = true;
          }
        }

        if (ambiguous) {
          logger.info('store_name_ambiguous', { query: nameQueryRaw, candidates: candidates.map(c => c.name) }, phone);
          return JSON.stringify({
            ambiguous_store_name: true,
            query: nameQueryRaw,
            candidates: candidates.map(c => ({ name: c.name, city_or_province: c.province, region: c.region })),
            message: `Ho trovato più negozi che potrebbero corrispondere a "${nameQueryRaw}". Chiedi al cliente di precisare quale.`,
          });
        }

        const avail = await checkBarcodeAvailability(barcode);
        let filtered = avail.stores;
        if (regionFilter) filtered = filtered.filter((s) => s.region.toLowerCase().includes(regionFilter));
        if (provinceFilter) filtered = filtered.filter((s) => s.province.toLowerCase().includes(provinceFilter));
        if (resolvedCodes) filtered = filtered.filter((s) => resolvedCodes!.has(s.code));

        const requestedStoreFound = resolvedCodes ? filtered.length > 0 : null;
        const resolvedStoreInfo = resolvedCodes ? candidates[0] : null;

        // Se il negozio richiesto non ha scorta, dai 5 alternative top nazionali.
        let alternatives: typeof avail.stores = [];
        if (resolvedCodes && filtered.length === 0) {
          alternatives = avail.stores.slice(0, 5);
        }

        const truncated = filtered.length > maxResults;
        const stores = filtered.slice(0, maxResults);
        logger.info('check_store_availability', {
          barcode, total: avail.total, returned: stores.length,
          region: regionFilter, province: provinceFilter,
          store_name_query: nameQueryRaw, resolved_store: resolvedStoreInfo?.name,
          requested_store_found: requestedStoreFound,
          alternatives_count: alternatives.length,
        }, phone);
        return JSON.stringify({
          found: avail.found,
          barcode,
          total_units_nationwide: avail.total,
          resolved_store: resolvedStoreInfo
            ? { name: resolvedStoreInfo.name, province: resolvedStoreInfo.province, region: resolvedStoreInfo.region }
            : undefined,
          stores_with_stock: stores,
          truncated,
          requested_store_found: requestedStoreFound,
          nearest_alternatives: alternatives.length > 0 ? alternatives : undefined,
        });
      }
      case 'find_similar_product': {
        const suffix = String(input.category_suffix ?? '').toUpperCase().trim();
        const keywords = String(input.search_keywords ?? '').trim();
        const visualDescription = String(input.visual_description ?? '').trim();

        // Costruisce il link di ricerca verificando che la query abbia risultati su Shopify.
        // Prova prima la query completa, poi accorcia di una parola alla volta finché trova
        // risultati (o scende a 1 parola). Evita link che portano a "0 risultati".
        const buildSearchUrl = async (): Promise<string> => {
          const tokens = keywords.trim().split(/\s+/).filter(Boolean);
          for (let len = tokens.length; len >= 1; len--) {
            const q = tokens.slice(0, len).join(' ');
            try {
              const res = await searchProducts(env, q);
              if (res.products.length > 0) {
                return `https://www.zuiki.it/search?options%5Bprefix%5D=last&q=${encodeURIComponent(q)}`;
              }
            } catch { /* ignora errori parziali */ }
          }
          // Fallback: usa la prima parola anche se 0 risultati (meglio di link completamente rotto)
          return `https://www.zuiki.it/search?options%5Bprefix%5D=last&q=${encodeURIComponent(tokens[0] ?? keywords)}`;
        };
        const searchUrl = await buildSearchUrl();

        let matchResult: {
          sku: string;
          title: string;
          url: string;
          image_url: string;
          category: string;
          similarity_percent: number;
        } | null = null;

        if (env.HF_SPACE_URL && env.PRODUCT_VECTORS) {
          // 1) FashionCLIP image embedding dalla foto del cliente (priorità massima)
          let embedding: number[] | null = clipEmbedding ?? null;
          let source = embedding ? 'fashion_clip_image' : '';

          // 2) FashionCLIP text embedding dalla visual_description (fallback se no foto)
          if (!embedding && visualDescription) {
            embedding = await computeTextEmbeddingFashionCLIP(env, visualDescription);
            source = 'fashion_clip_text';
          }

          if (embedding) {
            const topMatches = await findSimilarProducts(
              env,
              embedding,
              suffix || undefined,
              5
            );
            logger.info('fashion_clip_search', {
              source,
              suffix: suffix || 'any',
              visual_description: visualDescription.slice(0, 120),
              count: topMatches.length,
              top3: topMatches.slice(0, 3).map(m => ({
                handle: m.handle,
                score: Math.round(m.similarity * 1000) / 1000,
                title: m.title.slice(0, 40),
              })),
            }, phone);

            // Scegli il primo match con disponibilità > 0
            for (const match of topMatches) {
              try {
                const detail = await getProductByHandle(env, match.handle);
                const hasStock = (detail.total_inventory ?? 0) > 0;
                logger.info('availability_check', {
                  handle: match.handle,
                  total_inventory: detail.total_inventory,
                  available: hasStock,
                }, phone);
                if (!hasStock) continue;
                matchResult = {
                  sku: match.sku,
                  title: match.title,
                  url: match.url,
                  image_url: match.image_url,
                  category: getCategoryName(match.sku_suffix),
                  similarity_percent: Math.round(match.similarity * 100),
                };
                break;
              } catch {
                // Se Shopify non risponde, usa il match senza check
                matchResult = {
                  sku: match.sku,
                  title: match.title,
                  url: match.url,
                  image_url: match.image_url,
                  category: getCategoryName(match.sku_suffix),
                  similarity_percent: Math.round(match.similarity * 100),
                };
                break;
              }
            }
          }
        }

        return JSON.stringify({
          match: matchResult,
          search_url: searchUrl,
          search_keywords: keywords,
          visual_search_available: !!env.HF_SPACE_URL && !!env.PRODUCT_VECTORS,
        });
      }
      case 'get_return_status': {
        const rma = String(input.rma_number ?? '').trim();
        if (!env.RICHRETURNS_API_KEY) {
          return JSON.stringify({ error: 'richreturns_not_configured' });
        }
        const ret = await getReturnByRMA(env, rma);
        if (!ret) return JSON.stringify({ found: false, rma });
        return JSON.stringify({ found: true, ...ret });
      }
      case 'open_support_ticket': {
        const category = String(input.category ?? 'altro');
        const reason = String(input.reason ?? 'altro');
        const details = String(input.details ?? '');
        const urgency = String(input.urgency ?? 'normal');
        const ticketId = `ZOE-${Date.now()}`;

        // Aggiorna subito la riga conversations con dati ticket (se DB disponibile).
        if (env.ZOE_DB && convId) {
          upsertConversation(env.ZOE_DB, {
            convId,
            phoneHash: '',
            firstTs: Date.now(),
            lastTs: Date.now(),
            userTurns: 0,
            assistantTurns: 0,
            ticketId,
            ticketCategory: category,
            ticketReason: reason,
            ticketUrgency: urgency,
          }).catch(() => {});
        }

        // 1) Log strutturato (sempre, è fallback e audit trail)
        logger.info(
          'ticket_opened',
          {
            ticket_id: ticketId,
            category,
            reason,
            urgency,
            details,
            team_email: env.TEAM_EMAIL,
          },
          phone
        );

        // 2) Prova a creare il ticket nativo su Spoki
        let spokiTicketRef: string | null = null;
        try {
          spokiTicketRef = await createSpokiTicket(env, {
            phone,
            category,
            reason,
            details,
            urgency,
            zoeTicketId: ticketId,
          });
        } catch (err) {
          logger.error(
            'spoki_ticket_create_failed',
            { error: err instanceof Error ? err.message : String(err), ticket_id: ticketId },
            phone
          );
          // Non blocchiamo Zoe: il log sopra è già un ticket utilizzabile dal team.
        }

        return JSON.stringify({
          ticket_opened: true,
          ticket_id: ticketId,
          spoki_ticket_ref: spokiTicketRef,
          sla: 'lun-ven 8-17',
        });
      }
      default:
        return JSON.stringify({ error: 'unknown_tool', name });
    }
  } catch (err) {
    if (err instanceof ShopifyNotInstalledError) {
      logger.error('tool_shopify_not_installed', { tool: name }, phone);
      return JSON.stringify({ error: 'shopify_not_installed' });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('tool_execution_failed', { tool: name, error: msg }, phone);
    return JSON.stringify({ error: 'tool_failure', message: msg });
  }
}

function splitForWhatsApp(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parts = trimmed
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length <= 2) return parts;
  const first = parts[0]!;
  const rest = parts.slice(1).join(' ');
  return [first, rest];
}

// Limiti Anthropic: max 5MB per immagine. Lasciamo margine.
const MAX_IMAGE_BYTES = 4_500_000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

interface DownloadedImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/**
 * Scarica un'immagine dalla URL Spoki e la converte in base64.
 * Necessario perché Spoki firma le URL con `?key=...` che in alcuni casi i server
 * Anthropic non riescono a fetchare. Il Worker invece le scarica senza problemi.
 */
async function downloadImageAsBase64(url: string, phone: string): Promise<DownloadedImage | null> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      logger.warn('image_download_failed', { status: res.status, url_host: new URL(url).host }, phone);
      return null;
    }
    const ct = res.headers.get('content-type') ?? '';
    let mediaType: DownloadedImage['mediaType'] = 'image/jpeg';
    if (/image\/png/i.test(ct)) mediaType = 'image/png';
    else if (/image\/gif/i.test(ct)) mediaType = 'image/gif';
    else if (/image\/webp/i.test(ct)) mediaType = 'image/webp';
    else if (/image\/jpe?g/i.test(ct)) mediaType = 'image/jpeg';
    else {
      // Content-type ambiguo: assumiamo jpeg (Spoki manda quasi sempre jpeg).
      logger.info('image_ambiguous_content_type', { content_type: ct }, phone);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      logger.warn('image_too_large', { size: buf.byteLength }, phone);
      return null;
    }
    return { base64: arrayBufferToBase64(buf), mediaType };
  } catch (err) {
    logger.error(
      'image_download_exception',
      { error: err instanceof Error ? err.message : String(err) },
      phone
    );
    return null;
  }
}

function formatNowItalian(): string {
  // Forza locale italiana e timezone Europe/Rome per orario coerente con i clienti.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return fmt.format(now);
}

/**
 * Scarica tutte le immagini da una lista di URL e ritorna solo quelle riuscite.
 * Separato da buildFirstUserContent per riusare le immagini anche per CLIP embedding.
 */
async function downloadImages(imageUrls: string[], phone: string): Promise<DownloadedImage[]> {
  const downloads = await Promise.all(imageUrls.map((url) => downloadImageAsBase64(url, phone)));
  return downloads.filter((d): d is DownloadedImage => d !== null);
}

async function buildFirstUserContent(
  text: string,
  imageUrls: string[],
  phone: string,
  preDownloaded?: DownloadedImage[]
): Promise<Anthropic.MessageParam['content']> {
  // Iniezione ora corrente: aiuta Zoe a ragionare su "fra X ore", "stasera", ecc.
  const nowLine = `[Sistema — ora attuale (Italia): ${formatNowItalian()}]`;

  // Usa le immagini pre-scaricate se disponibili, altrimenti scarica ora.
  const validImages = preDownloaded ?? await downloadImages(imageUrls, phone);

  if (validImages.length === 0) {
    // Caso solo testo (anche se l'utente ha mandato immagini, se il download è fallito).
    if (imageUrls.length > 0 && validImages.length === 0) {
      logger.warn('all_images_failed_download', { count: imageUrls.length }, phone);
      // Avvisa Claude che il cliente ha mandato un'immagine ma non è leggibile
      const fallbackText = text
        ? `${nowLine}\n\n${text}\n\n[Sistema: il cliente ha allegato un'immagine ma non sono riuscita a scaricarla. Ignora l'immagine e rispondi al testo.]`
        : `${nowLine}\n\n[Sistema: il cliente ha mandato solo un'immagine ma il download è fallito. Chiedi al cliente di descrivere o di rimandare la foto.]`;
      return fallbackText;
    }
    // Solo testo, niente immagini
    return text ? `${nowLine}\n\n${text}` : nowLine;
  }

  // Multimodale: blocchi image + text con preamble di tempo
  const blocks: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
  for (const img of validImages) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.base64,
      },
    });
  }
  // Sempre un text block (anche solo con preamble e nota immagine)
  const textPart = text
    ? `${nowLine}\n\n${text}`
    : `${nowLine}\n\n[Il cliente ha mandato solo un'immagine senza testo. Guarda cosa c'è e rispondi di conseguenza: se è uno screenshot di un ordine, leggi il numero d'ordine e chiedi l'email per verificare. Se è una foto di un capo/accessorio (su modella, da sito, da social, o foto personale), usa find_similar_product per cercare qualcosa di simile nel catalogo Zuiki. Se è una foto di outfit, suggerisci abbinamenti dal catalogo con search_products.]`;
  blocks.push({ type: 'text', text: textPart });
  return blocks;
}

export async function processMessage(
  env: Env,
  phone: string,
  userMessage: string,
  history: StoredMessage[],
  anthropicClient?: Anthropic,
  images: string[] = [],
  convId?: string,
  humanActive = false
): Promise<string[]> {
  const anthropic = anthropicClient ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Scarica immagini una sola volta (per Claude content e FashionCLIP embedding).
  const downloadedImages = images.length > 0 ? await downloadImages(images, phone) : [];

  // Calcola FashionCLIP embedding dalla prima immagine (usato da find_similar_product).
  const firstImage = downloadedImages[0];
  const clipEmbedding =
    firstImage && env.HF_SPACE_URL
      ? await computeImageEmbeddingFashionCLIP(env, firstImage.base64)
      : null;
  logger.info('clip_embedding', {
    has_image: !!firstImage,
    hf_space_url: !!env.HF_SPACE_URL,
    embedding_dim: clipEmbedding?.length ?? 0,
    success: !!clipEmbedding,
  }, phone);

  const firstUserContent = await buildFirstUserContent(userMessage, images, phone, downloadedImages);
  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: firstUserContent },
  ];

  // Prompt caching Anthropic: il system prompt è statico e lungo (~3.5k token).
  // Passandolo come block con cache_control:ephemeral, gli input_tokens successivi
  // entro 5 minuti usano il cache (~90% sconto sui token di prompt).
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Se un operatore CC ha già preso in carico la chat, lo comunichiamo esplicitamente
  // a Claude come secondo blocco di system (non in cache, perché varia per chat).
  if (humanActive) {
    systemBlocks.push({
      type: 'text',
      text: '⚠️ OPERATORE CC ATTIVO: un agente umano del customer care ha preso in carico questa conversazione. Rispondi SOLO con [NO_REPLY] (e nient\'altro). Non mandare nessun messaggio al cliente.',
    });
  }

  let iterations = 0;
  let finalText = '';
  let exhausted = false;

  // Chiama l'API Anthropic con retry su errori transitori (429, 529, 503).
  // Timeout 25s per evitare che il Worker resti appeso se Anthropic è lento.
  async function callClaude(attempt = 0): Promise<Anthropic.Message> {
    try {
      return await anthropic.messages.create(
        {
          model: CLAUDE_MODEL,
          max_tokens: CLAUDE_MAX_TOKENS,
          system: systemBlocks,
          tools: TOOL_DEFINITIONS,
          messages,
        },
        { signal: AbortSignal.timeout(25_000) }
      );
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const isRetryable = status === 429 || status === 503 || status === 529 || status === 0;
      if (isRetryable && attempt < 2) {
        const backoff = (attempt + 1) * 1000;
        logger.warn('claude_api_retry', { attempt, status, backoff_ms: backoff }, phone);
        await new Promise(res => setTimeout(res, backoff));
        return callClaude(attempt + 1);
      }
      throw err;
    }
  }

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const t0 = Date.now();
    let response: Anthropic.Message;
    try {
      response = await callClaude();
    } catch (err) {
      logger.error('claude_api_failed', {
        iteration: iterations,
        error: err instanceof Error ? err.message : String(err),
        message_count: messages.length,
        last_role: messages[messages.length - 1]?.role,
      }, phone);
      throw err;
    }
    const latency = Date.now() - t0;
    const usage = response.usage;
    logger.info(
      'claude_api_call',
      {
        iteration: iterations,
        stop_reason: response.stop_reason,
        tokens_in: usage?.input_tokens,
        tokens_out: usage?.output_tokens,
        cache_read: usage?.cache_read_input_tokens,
        cache_create: usage?.cache_creation_input_tokens,
        latency_ms: latency,
      },
      phone
    );
    // Scrivi la chiamata API nel database analytics (async, non blocca).
    if (env.ZOE_DB && convId && usage) {
      const callData: ApiCallData = {
        model: CLAUDE_MODEL,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: (usage as unknown as Record<string,number>).cache_read_input_tokens ?? 0,
        cacheCreationTokens: (usage as unknown as Record<string,number>).cache_creation_input_tokens ?? 0,
        latencyMs: latency,
        iteration: iterations,
        stopReason: response.stop_reason ?? '',
      };
      insertApiCall(env.ZOE_DB, convId, callData).catch(() => {});
    }

    if (response.stop_reason === 'tool_use') {
      if (iterations >= MAX_TOOL_ITERATIONS) {
        exhausted = true;
        break;
      }
      messages.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          logger.info(
            'tool_call',
            { tool: block.name, input: block.input },
            phone
          );
          const result = await executeTool(env, phone, block.name, block.input as Record<string, unknown>, clipEmbedding, convId);
          // Traccia tool call nel DB analytics.
          if (env.ZOE_DB && convId) {
            insertToolCall(env.ZOE_DB, convId, { toolName: block.name, success: true }).catch(() => {});
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      iterations++;
      continue;
    }

    finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    break;
  }

  if (exhausted) {
    logger.warn('tool_iterations_exceeded', {}, phone);
    return ['Un attimo, faccio verificare al team.'];
  }

  // Marker [NO_REPLY]: il prompt istruisce Claude a usarlo dopo 2 rifiuti consecutivi
  // sullo stesso tema fuori-ambito, per interrompere loop di provocazione/insistenza.
  // Quando lo riceviamo, restituiamo array vuoto: il webhook handler non manda nulla.
  if (/\[NO_?REPLY\]/i.test(finalText)) {
    logger.info('no_reply_triggered', { reason: 'model_marker', original_chars: finalText.length }, phone);
    return [];
  }

  const parts = splitForWhatsApp(finalText);
  if (parts.length === 0) {
    logger.warn('empty_model_response', {}, phone);
    return ['Un attimo, sto verificando.'];
  }
  return parts;
}

export const __test__ = { splitForWhatsApp, buildFirstUserContent };
