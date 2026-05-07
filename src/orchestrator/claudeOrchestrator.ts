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
import {
  computeImageEmbeddingFashionCLIP,
  computeTextEmbeddingFashionCLIP,
  findSimilarProducts,
} from '../clients/vectorizeClient';
import { logger } from '../utils/logger';
import type { StoredMessage } from '../storage/kvStore';
import { ZUIKI_STORES } from '../data/stores';
import { getCategoryName } from '../data/skuSuffixes';

function searchStores(input: Record<string, unknown>) {
  const city = (input.city as string | undefined)?.toLowerCase().trim();
  const region = (input.region as string | undefined)?.toLowerCase().trim();
  const query = (input.query as string | undefined)?.toLowerCase().trim();

  const matches = ZUIKI_STORES.filter((s) => {
    if (city && !s.city.toLowerCase().includes(city)) return false;
    if (region && !s.region.toLowerCase().includes(region)) return false;
    if (query) {
      const hay = `${s.name} ${s.address} ${s.city}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  }).slice(0, 15);

  return {
    total_in_catalog: ZUIKI_STORES.length,
    found: matches.length,
    stores: matches.map((s) => ({
      name: s.name,
      region: s.region,
      city: s.city,
      address: s.address,
      tel: s.tel,
      hours_weekday: s.hoursWeekday,
      hours_saturday: s.hoursSat,
      hours_sunday: s.hoursSun,
    })),
  };
}

async function executeTool(
  env: Env,
  phone: string,
  name: string,
  input: Record<string, unknown>,
  clipEmbedding?: number[] | null
): Promise<string> {
  try {
    switch (name) {
      case 'get_order_by_number_and_email': {
        const res = await getOrderByNameAndEmail(
          env,
          String(input.order_number ?? ''),
          String(input.email ?? '')
        );
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
        // Questo tool è locale (dati statici in src/data/stores.ts), non chiama API esterne.
        return JSON.stringify(searchStores(input));
      }
      case 'find_similar_product': {
        const suffix = String(input.category_suffix ?? '').toUpperCase().trim();
        const keywords = String(input.search_keywords ?? '').trim();
        const visualDescription = String(input.visual_description ?? '').trim();

        // Link di ricerca testuale (max 2 parole per avere risultati su Shopify).
        const queryWords = keywords.split(/\s+/).slice(0, 2).join('+');
        const searchUrl = `https://www.zuiki.it/search?options%5Bprefix%5D=last&q=${queryWords}`;

        let matchResult: {
          sku: string;
          title: string;
          url: string;
          image_url: string;
          category: string;
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
      case 'open_support_ticket': {
        const reason = String(input.reason ?? 'other');
        const details = String(input.details ?? '');
        const urgency = String(input.urgency ?? 'normal');
        const ticketId = `ZOE-${Date.now()}`;

        // 1) Log strutturato (sempre, è fallback e audit trail)
        logger.info(
          'ticket_opened',
          {
            ticket_id: ticketId,
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
  images: string[] = []
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

  let iterations = 0;
  let finalText = '';
  let exhausted = false;

  while (iterations <= MAX_TOOL_ITERATIONS) {
    const t0 = Date.now();
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemBlocks,
      tools: TOOL_DEFINITIONS,
      messages,
    });
    const latency = Date.now() - t0;
    logger.info(
      'claude_api_call',
      {
        iteration: iterations,
        stop_reason: response.stop_reason,
        tokens_in: response.usage?.input_tokens,
        tokens_out: response.usage?.output_tokens,
        cache_read: response.usage?.cache_read_input_tokens,
        cache_create: response.usage?.cache_creation_input_tokens,
        latency_ms: latency,
      },
      phone
    );

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
          const result = await executeTool(env, phone, block.name, block.input as Record<string, unknown>, clipEmbedding);
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
