import { describe, it, expect } from 'vitest';
import { bufferInbound, claimBurst } from '../src/storage/inboundBuffer';
import { ensureConversation, loadVerifiedOrders } from '../src/analytics/db';
import { makeD1 } from './helpers';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('raccolta messaggi ravvicinati (debounce su D1)', () => {
  it('numero d\'ordine + email in due messaggi diventano un solo turno', async () => {
    const db = makeD1();
    const a = await bufferInbound(db, '+393490862552', '#283308 numero ordine', []);
    await tick();
    const b = await bufferInbound(db, '393490862552', 'stefania@example.it', []);
    // Il primo messaggio non risponde: è arrivato un messaggio più recente.
    expect(await claimBurst(db, '+393490862552', a)).toBeNull();
    // L'ultimo prende tutto il gruppo, in ordine.
    const parts = await claimBurst(db, '+393490862552', b);
    expect(parts?.map((p) => p.text)).toEqual(['#283308 numero ordine', 'stefania@example.it']);
    // Il gruppo è stato consumato: un secondo tentativo non risponde di nuovo.
    expect(await claimBurst(db, '+393490862552', b)).toBeNull();
  });

  it('un messaggio singolo viene elaborato da solo', async () => {
    const db = makeD1();
    const a = await bufferInbound(db, '3331112222', 'ciao', ['https://img/x.jpg']);
    const parts = await claimBurst(db, '3331112222', a);
    expect(parts).toHaveLength(1);
    expect(parts![0]!.images).toEqual(['https://img/x.jpg']);
  });

  it('i messaggi di clienti diversi non si mescolano', async () => {
    const db = makeD1();
    const a = await bufferInbound(db, '3331112222', 'cliente A', []);
    await tick();
    const b = await bufferInbound(db, '3339998888', 'cliente B', []);
    expect((await claimBurst(db, '3331112222', a))?.map((p) => p.text)).toEqual(['cliente A']);
    expect((await claimBurst(db, '3339998888', b))?.map((p) => p.text)).toEqual(['cliente B']);
  });

  it('gli avanzi vecchi di un\'esecuzione interrotta non vengono incollati al turno', async () => {
    const db = makeD1();
    await bufferInbound(db, '3331112222', 'init', []); // crea la tabella
    db.raw.prepare('DELETE FROM inbound_buffer').run();
    db.raw.prepare('INSERT INTO inbound_buffer (id, phone_key, ts, text, images_json) VALUES (?,?,?,?,?)')
      .run('old', '3331112222', Date.now() - 10 * 60_000, 'messaggio di 10 minuti fa', '[]');
    const b = await bufferInbound(db, '3331112222', 'nuovo', []);
    expect((await claimBurst(db, '3331112222', b))?.map((p) => p.text)).toEqual(['nuovo']);
  });
});

describe('ordini già verificati', () => {
  it('recupera numero d\'ordine ed email delle verifiche riuscite, senza duplicati', async () => {
    const db = makeD1();
    const conv = 'abc_1';
    await ensureConversation(db, conv, 'abc', '393490862552', Date.now());
    const ins = db.raw.prepare('INSERT INTO tool_calls (id, conv_id, ts, tool_name, success, input_json, output_json) VALUES (?,?,?,?,?,?,?)');
    const now = Date.now();
    ins.run('t1', conv, now - 3000, 'get_order_by_number_and_email', 1, '{"order_number":"283308","email":"s@x.it"}', '{"found":true,"name":"#283308"}');
    ins.run('t2', conv, now - 2000, 'get_order_by_number_and_email', 1, '{"order_number":"#283308","email":"s@x.it"}', '{"found":true,"name":"#283308"}');
    ins.run('t3', conv, now - 1000, 'get_order_by_number_and_email', 1, '{"order_number":"999999","email":"s@x.it"}', '{"found":false}');
    ins.run('t4', conv, now - 500, 'search_products', 1, '{"query":"cardigan"}', '{"found":true}');
    const orders = await loadVerifiedOrders(db, conv, now - 60_000);
    expect(orders).toEqual([{ orderNumber: '283308', email: 's@x.it', ts: now - 2000 }]);
  });
});
