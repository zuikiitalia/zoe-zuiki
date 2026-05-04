import { describe, it, expect, vi, beforeEach } from 'vitest';

// Finto KVNamespace in-memory per i test unitari.
function makeMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: 'json' | 'text') => {
      const v = store.get(key);
      if (!v) return null;
      if (type === 'json') return JSON.parse(v);
      return v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

function makeEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ZOE_KV: makeMockKV(),
    ANTHROPIC_API_KEY: 'sk-ant-test',
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    SHOPIFY_SHOP_DOMAIN: 'zuiki-italia.myshopify.com',
    SPOKI_API_KEY: 'test-spoki',
    WEBHOOK_SECRET: 'test-webhook-secret',
    TEAM_EMAIL: 'shoponline@zuiki.it',
    WHATSAPP_NUMBER: '+390230550379',
    ...overrides,
  };
}

function stubExecutionCtx() {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

describe('GET /health', () => {
  it('risponde 200 con status ok', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /webhook/spoki', () => {
  it('ritorna 401 senza webhook secret', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request(
      '/webhook/spoki',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(),
      stubExecutionCtx()
    );
    expect(res.status).toBe(401);
  });

  it('ritorna 200 con payload fittizio (evento non-inbound viene ignorato, no crash)', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request(
      '/webhook/spoki?secret=test-webhook-secret',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'delivery_update', foo: 'bar' }),
      },
      makeEnv(),
      stubExecutionCtx()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('ritorna 400 su JSON invalido', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request(
      '/webhook/spoki?secret=test-webhook-secret',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '<<<<not-json>>>>',
      },
      makeEnv(),
      stubExecutionCtx()
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /shopify/install', () => {
  it("se il token esiste già ritorna 'already installed'", async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');
    const app = (await import('../src/index')).default;
    const res = await app.request('/shopify/install', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'already installed' });
  });

  it('senza token redirige a Shopify OAuth', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request('/shopify/install', {}, makeEnv());
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('zuiki-italia.myshopify.com/admin/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toContain('state=');
  });
});

describe('GET /shopify/callback', () => {
  it('ritorna 401 senza HMAC valido', async () => {
    const app = (await import('../src/index')).default;
    const res = await app.request(
      '/shopify/callback?code=x&state=y&shop=zuiki-italia.myshopify.com',
      {},
      makeEnv()
    );
    expect(res.status).toBe(401);
  });
});

describe('orchestrator.processMessage (mock Claude)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('ritorna un array di stringhe quando Claude risponde con testo', async () => {
    const fakeResponse = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Ciao, come posso aiutarti?' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    };
    const fakeClient = {
      messages: { create: vi.fn().mockResolvedValue(fakeResponse) },
    };
    const { processMessage } = await import('../src/orchestrator/claudeOrchestrator');
    const env = makeEnv();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processMessage(env as any, '+391111111', 'ciao', [], fakeClient as any);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain('Ciao');
    expect(fakeClient.messages.create).toHaveBeenCalledOnce();
  });

  it('spezza la risposta di Claude su \\n\\n in più messaggi', async () => {
    const { __test__ } = await import('../src/orchestrator/claudeOrchestrator');
    const parts = __test__.splitForWhatsApp('Prima riga.\n\nSeconda riga.');
    expect(parts).toEqual(['Prima riga.', 'Seconda riga.']);
  });

  it('concatena nel 2° messaggio se Claude ne genera più di 2', async () => {
    const { __test__ } = await import('../src/orchestrator/claudeOrchestrator');
    const parts = __test__.splitForWhatsApp('A.\n\nB.\n\nC.\n\nD.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('A.');
    expect(parts[1]).toBe('B. C. D.');
  });
});

describe('shopifyClient.getOrderByNameAndEmail (mock fetch)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("ritorna { found: true, ... } quando Shopify trova un ordine con email corrispondente", async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: 'gid://shopify/Order/1',
                    name: '#259134',
                    email: 'mario@example.com',
                    createdAt: '2026-04-20T10:00:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'UNFULFILLED',
                    totalPriceSet: { shopMoney: { amount: '49.00', currencyCode: 'EUR' } },
                    shippingAddress: { city: 'Milano', country: 'IT' },
                    lineItems: { edges: [{ node: { title: 'T-shirt', quantity: 1, variant: { title: 'M' } } }] },
                    fulfillments: [],
                    tags: [],
                    metafields: { edges: [] },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const { getOrderByNameAndEmail } = await import('../src/clients/shopifyClient');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getOrderByNameAndEmail(env as any, '#259134', 'mario@example.com');
    expect(res.found).toBe(true);
    expect(res.order_number).toBe('#259134');
    expect(res.total?.amount).toBe('49.00');
    expect(res.items?.[0]?.title).toBe('T-shirt');

    vi.unstubAllGlobals();
  });

  it("rileva pickup dal metafield e parsa i tag STATUS:* in cronologia", async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    name: '#259327',
                    email: 'g.debora1970@gmail.com',
                    createdAt: '2026-04-22T20:21:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'FULFILLED',
                    totalPriceSet: { shopMoney: { amount: '29.95', currencyCode: 'EUR' } },
                    shippingAddress: { city: 'Napoli', country: 'IT' },
                    lineItems: { edges: [{ node: { title: 'Jeans palazzo crop', quantity: 1, variant: { title: 'Bianco / 38' } } }] },
                    fulfillments: [],
                    tags: [
                      'STATUS:PREPARED:23/04/2026:1246',
                      'STATUS:SHIPPED:24/04/2026:1036',
                      'STATUS:SHIPPING:23/04/2026:1250',
                      'VOMER',
                    ],
                    metafields: {
                      edges: [
                        {
                          node: {
                            namespace: 'custom',
                            key: 'Pickup',
                            value: '#VOMER# Napoli - Via Luca Giordano Via Luca Giordano Ang. Via Solimena',
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const { getOrderByNameAndEmail } = await import('../src/clients/shopifyClient');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getOrderByNameAndEmail(env as any, '#259327', 'g.debora1970@gmail.com');
    expect(res.found).toBe(true);
    expect(res.delivery_method).toBe('pickup');
    expect(res.pickup_store_code).toBe('VOMER');
    expect(res.pickup_store_label).toContain('Napoli');
    // Cronologia ordinata: PREPARED → SHIPPING → SHIPPED
    expect(res.status_history).toHaveLength(3);
    expect(res.status_history?.[0]?.name).toBe('PREPARED');
    expect(res.status_history?.[1]?.name).toBe('SHIPPING');
    expect(res.status_history?.[2]?.name).toBe('SHIPPED');
    expect(res.latest_status?.name).toBe('SHIPPED');
    // Pickup → tracking sempre vuoto
    expect(res.tracking).toEqual([]);
    // Riscontro col catalogo: il negozio di Napoli Via Luca Giordano deve matchare un negozio reale
    expect(res.pickup_store_match).toBeDefined();
    expect(res.pickup_store_match?.city.toLowerCase()).toContain('napoli');

    vi.unstubAllGlobals();
  });

  it('DELIVERED vince come latest_status anche se cronologicamente non è ultimo, e parsa NAME con digit (INTRANSIT1)', async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    name: '#260100',
                    email: 'cliente@example.com',
                    createdAt: '2026-04-23T10:00:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'FULFILLED',
                    totalPriceSet: { shopMoney: { amount: '49.00', currencyCode: 'EUR' } },
                    shippingAddress: { city: 'Milano', country: 'IT' },
                    lineItems: { edges: [{ node: { title: 'Maglione', quantity: 1, variant: { title: 'M' } } }] },
                    fulfillments: [],
                    // Sequenza reale osservata in produzione: il carrier ha mandato un evento DELIVERING
                    // dopo il DELIVERED (timestamp 11:39 vs 00:06 stesso giorno). DELIVERED deve vincere.
                    tags: [
                      'STATUS:DELIVERED:24/04/2026:0006',
                      'STATUS:DELIVERING:24/04/2026:1139',
                      'STATUS:INTRANSIT1:23/04/2026:1816',
                      'STATUS:PREPARED:23/04/2026:1156',
                      'STATUS:SHIPPED:23/04/2026:1530',
                      'STATUS:SHIPPING:23/04/2026:1257',
                    ],
                    metafields: { edges: [] },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const { getOrderByNameAndEmail } = await import('../src/clients/shopifyClient');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getOrderByNameAndEmail(env as any, '#260100', 'cliente@example.com');
    expect(res.found).toBe(true);
    // 6 tag STATUS:* TUTTI parsati (incluso INTRANSIT1 con digit nel nome)
    expect(res.status_history).toHaveLength(6);
    const names = res.status_history?.map((s) => s.name);
    expect(names).toContain('INTRANSIT1');
    // Cronologia ordinata correttamente per timestamp
    expect(res.status_history?.[0]?.name).toBe('PREPARED');
    expect(res.status_history?.[res.status_history.length - 1]?.name).toBe('DELIVERING');
    // MA latest_status = DELIVERED (override per stato terminale)
    expect(res.latest_status?.name).toBe('DELIVERED');
    expect(res.latest_status?.date).toBe('24/04/2026');
    expect(res.latest_status?.time).toBe('00:06');

    vi.unstubAllGlobals();
  });

  it('cross-reference: pickup label "Pavia Corso Cavour" trova il negozio Pavia C.S.', async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    name: '#260000',
                    email: 'cliente@example.com',
                    createdAt: '2026-04-25T12:00:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'IN_PROGRESS',
                    totalPriceSet: { shopMoney: { amount: '39.95', currencyCode: 'EUR' } },
                    shippingAddress: { city: 'Milano', country: 'IT' },
                    lineItems: { edges: [{ node: { title: 'Maglione', quantity: 1, variant: { title: 'M' } } }] },
                    fulfillments: [],
                    tags: ['STATUS:PREPARED:25/04/2026:1500'],
                    metafields: {
                      edges: [
                        {
                          node: {
                            namespace: 'custom',
                            key: 'Pickup',
                            value: 'Pavia Corso Cavour',
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const { getOrderByNameAndEmail } = await import('../src/clients/shopifyClient');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getOrderByNameAndEmail(env as any, '#260000', 'cliente@example.com');
    expect(res.found).toBe(true);
    expect(res.delivery_method).toBe('pickup');
    expect(res.pickup_store_match).toBeDefined();
    expect(res.pickup_store_match?.name).toBe('Pavia C.S.');
    expect(res.pickup_store_match?.address).toContain('Corso Cavour');

    vi.unstubAllGlobals();
  });

  it('ritorna { found: false } se email non corrisponde', async () => {
    const env = makeEnv();
    await (env.ZOE_KV as KVNamespace).put('shopify:access_token', 'fake-token');

    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            orders: {
              edges: [
                {
                  node: {
                    name: '#259134',
                    email: 'qualcunaltro@example.com',
                    createdAt: '2026-04-20T10:00:00Z',
                    displayFinancialStatus: 'PAID',
                    displayFulfillmentStatus: 'UNFULFILLED',
                    totalPriceSet: null,
                    shippingAddress: null,
                    lineItems: { edges: [] },
                    fulfillments: [],
                    tags: [],
                    metafields: { edges: [] },
                  },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', mockFetch);

    const { getOrderByNameAndEmail } = await import('../src/clients/shopifyClient');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getOrderByNameAndEmail(env as any, '#259134', 'mario@example.com');
    expect(res.found).toBe(false);

    vi.unstubAllGlobals();
  });
});
