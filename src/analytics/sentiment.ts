import Anthropic from '@anthropic-ai/sdk';
import type { StoredMessage } from '../storage/kvStore';

export interface SentimentResult {
  sentiment: 'satisfied' | 'partial' | 'unsatisfied' | 'unknown';
  note: string;
}

const PROMPT = `Analizza questa conversazione WhatsApp tra un cliente e un assistente virtuale di un negozio di abbigliamento.

Classifica il sentiment finale del cliente con UNA sola parola:
- satisfied: cliente ha ottenuto quello che cercava, tono positivo o neutro in chiusura
- partial: problema parzialmente risolto o cliente non ha risposto dopo la soluzione
- unsatisfied: cliente ancora arrabbiato, frustrato o ha chiuso senza soluzione

Rispondi SOLO con JSON: {"sentiment":"VALORE","note":"1 frase breve sul motivo"}

CONVERSAZIONE:
{CONV}`;

export async function analyzeSentiment(
  apiKey: string,
  messages: StoredMessage[]
): Promise<SentimentResult> {
  if (messages.length < 2) return { sentiment: 'unknown', note: 'conversazione troppo breve' };

  // Prende le ultime 10 coppie al massimo per contenere i costi.
  const last = messages.slice(-20);
  const text = last.map(m => `${m.role === 'user' ? 'Cliente' : 'Zoe'}: ${m.content.slice(0, 300)}`).join('\n');

  const anthropic = new Anthropic({ apiKey });
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{ role: 'user', content: PROMPT.replace('{CONV}', text) }],
    });
    const raw = res.content.find(b => b.type === 'text')?.text ?? '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { sentiment: 'unknown', note: 'parsing fallito' };
    const parsed = JSON.parse(match[0]) as { sentiment: string; note: string };
    const valid = ['satisfied', 'partial', 'unsatisfied', 'unknown'];
    return {
      sentiment: (valid.includes(parsed.sentiment) ? parsed.sentiment : 'unknown') as SentimentResult['sentiment'],
      note: parsed.note?.slice(0, 200) ?? '',
    };
  } catch {
    return { sentiment: 'unknown', note: 'errore analisi' };
  }
}
