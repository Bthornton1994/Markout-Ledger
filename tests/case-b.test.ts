import { describe, expect, it } from 'vitest';
import { PaperExchange, Priority, Scheduler, parseMoney, parsePrice, parseQty, replay, type BookEvent, type ExecutionEvent, type TradeEvent } from '../src/index.js';
import { DEFAULT_EXECUTION } from '../src/scenarios.js';
import { T0, TICK, fixedQuotePolicy, flatBooks, makeFixture, testConfig, trade } from './helpers.js';

/**
 * Audit Case B. Our bid rests at 99.90 behind a displayed queue of 2.0.
 *   print X: at our price, size 1.0, venue time 100, observed at 300 (lagged)
 *   print Y: through our price, size 0.3, venue time 200, observed at 250
 * Venue order (X then Y): X is absorbed by the queue (2.0 -> 1.0, no fill); Y sweeps the level and fills 0.3.
 * Arrival order (Y then X): Y fills 0.3 and zeroes the queue; X then finds no queue and fills the remaining 0.7.
 * Only 0.300 is supported by the data.
 */
function book(t: number, bidSize: string): BookEvent {
  return {
    type: 'book',
    eventId: `b${t}`,
    seq: t,
    obsTime: T0 + t,
    marketTime: T0 + t,
    symbol: 'X',
    venue: 'test',
    bids: [{ price: parsePrice('99.90'), size: parseQty(bidSize) }, { price: parsePrice('99.89'), size: parseQty('2') }],
    asks: [{ price: parsePrice('99.92'), size: parseQty('2') }, { price: parsePrice('99.93'), size: parseQty('2') }],
  };
}
function print(obs: number, market: number, price: string, size: string): TradeEvent {
  return { type: 'trade', eventId: `t${obs}`, seq: 1000 + obs, obsTime: T0 + obs, marketTime: T0 + market, symbol: 'X', venue: 'test', tradeId: `t${obs}`, price: parsePrice(price), size: parseQty(size), aggressor: 'sell' };
}

describe('Case B: prints arriving out of venue order', () => {
  it('exchange level: awards only the fill supported by venue-time ordering', () => {
    const scheduler = new Scheduler();
    const events: ExecutionEvent[] = [];
    let latest: BookEvent | null = null;
    const ex = new PaperExchange({ ...DEFAULT_EXECUTION, tickSize: TICK }, scheduler, (e) => events.push(e), () => latest, { maxTradeLagMs: 500 });
    scheduler.schedule(T0, Priority.MARKET, () => void (latest = book(0, '2')));
    scheduler.schedule(T0 + 20, Priority.TICK, () => {
      ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 20); // live at 70
    });
    const y = print(250, 200, '99.85', '0.3');
    const x = print(300, 100, '99.90', '1.0');
    scheduler.schedule(y.obsTime, Priority.MARKET, () => ex.onTrade(y, y.obsTime));
    scheduler.schedule(x.obsTime, Priority.MARKET, () => ex.onTrade(x, x.obsTime));
    for (let item = scheduler.pop(); item; item = scheduler.pop()) void item.run();

    const fills = events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill' }> => e.kind === 'fill');
    const total = fills.reduce((s, f) => s + f.qty, 0n);
    expect(total).toBe(parseQty('0.3'));
    expect(ex.get('o1')!.filledQty).toBe(parseQty('0.3'));
    expect(ex.get('o1')!.state).toBe('live');
  });

  it('replay level: the same two prints through the engine book 0.300, at observation time, with the ledger reconciling', async () => {
    const fx = makeFixture(
      [
        ...flatBooks(0, 3000, '99.90', '99.92', 100, { bidSize: '2' }),
        trade(200, '99.85', '0.3', 'sell', { lag: 50 }), // Y: venue 200, observed 250
        trade(100, '99.90', '1.0', 'sell', { lag: 200 }), // X: venue 100, observed 300
      ],
      { durationMs: 3000 },
    );
    const r = await replay({ fixture: fx, policy: fixedQuotePolicy({ bid: '99.90', qty: '1' }), controller: null, config: testConfig({ steering: 'disabled' }) });
    const fills = r.ledger.ofType('fill');
    expect(fills.map((f) => [f.simTime - T0, f.sourceMarketTime - T0, f.qty])).toEqual([[250, 200, '0.300000']]);
    expect(r.summary.fills.qty).toBe('0.300000');
    // X is recorded as absorbed by the queue in venue order, not as a fill
    expect(r.ledger.ofType('queue_consumed').map((q) => q.simTime - T0)).toEqual([300]);
    const decisions = r.ledger.ofType('policy_decision');
    expect(decisions.find((d) => d.simTime === T0 + 300)!.input.inventory).toBe('0.300000');
    expect(decisions.find((d) => d.simTime === T0 + 600)!.input.inventory).toBe('0.300000');
    const p = r.summary.portfolio;
    expect(parseMoney(p.netPnl)).toBe(parseMoney(p.grossRealized) + parseMoney(p.unrealized) - parseMoney(p.feesPaid) - parseMoney(p.txCostsPaid));
  });

  it('the mirror case: a late-observed earlier print through our price releases an at-price print already absorbed by the queue', () => {
    const h = exchange();
    h.at(20, () => {
      h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 20); // live at 70
    });
    h.feed(print(250, 200, '99.90', '1.0')); // at price, absorbed by queue 2.0 -> 1.0 when observed
    h.feed(print(300, 100, '99.85', '0.5')); // through, but printed BEFORE the at-price print
    h.run();
    const fills = h.fills();
    // venue order: through at 100 fills 0.5 and zeroes the queue; at-price at 200 then fills the remaining 0.5.
    // Both are booked when the through print is observed, each citing its own source print and venue time.
    expect(fills.map((f) => [f.at - T0, f.sourceTrade.marketTime - T0, f.qty, f.fillType, f.establishedBy.marketTime - T0])).toEqual([
      [300, 100, parseQty('0.5'), 'trade_through', 100],
      [300, 200, parseQty('0.5'), 'queue_exhausted', 100],
    ]);
    for (const f of fills) expect(f.qty <= f.sourceTrade.size).toBe(true);
    expect(h.kinds().filter((k) => k === 'queue_consumed')).toHaveLength(1); // the at-price print, when it was observed
    expect(h.ex.get('o1')!.state).toBe('filled');
    expect([...h.ex.get('o1')!.awardedBySource.values()].map((a) => [a.trade.marketTime - T0, a.qty])).toEqual([
      [100, parseQty('0.5')],
      [200, parseQty('0.5')],
    ]);
  });

  it('a late-observed earlier through print re-splits already-booked quantity: provenance moves, accounting does not', () => {
    const h = exchange('0');
    h.at(20, () => {
      h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 20); // live at 70
    });
    h.feed(print(250, 200, '99.85', '1.0')); // B: through, fills the whole order when observed
    h.feed(print(300, 100, '99.85', '0.5')); // A: through, printed before B: in venue order A fills 0.5 and B only 0.5
    h.run();
    expect(h.fills().map((f) => [f.at - T0, f.sourceTrade.marketTime - T0, f.qty])).toEqual([[250, 200, parseQty('1')]]);
    const re = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill_reattributed' }> => e.kind === 'fill_reattributed');
    expect(re.map((r) => [r.at - T0, r.fromTrade.marketTime - T0, r.toTrade.marketTime - T0, r.qty])).toEqual([[300, 200, 100, parseQty('0.5')]]);
    const o = h.ex.get('o1')!;
    expect(o.filledQty).toBe(parseQty('1'));
    expect([...o.awardedBySource.values()].map((a) => [a.trade.marketTime - T0, a.qty])).toEqual([
      [200, parseQty('0.5')],
      [100, parseQty('0.5')],
    ]);
  });

  it('a late earlier print shifts a shared print between our own orders without over-awarding', () => {
    const h = exchange('0');
    h.at(20, () => {
      h.ex.submit({ clientId: 'a', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 20); // live 70
    });
    h.at(30, () => {
      h.ex.submit({ clientId: 'b', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 30); // live 80
    });
    h.feed(print(100, 100, '99.85', '1.0')); // P: a (earlier live) takes all 1.0
    h.feed(print(400, 90, '99.85', '0.5')); // Q: printed before P; in venue order a takes 0.5 of Q, then 0.5 of P, b gets 0.5 of P
    h.run();
    const byOrder = (id: string) => h.fills().filter((f) => f.order.orderId === id).map((f) => [f.at - T0, f.qty]);
    expect(byOrder('o1')).toEqual([[100, parseQty('1')]]);
    expect(byOrder('o2')).toEqual([[400, parseQty('0.5')]]);
    expect(h.ex.get('o1')!.filledQty).toBe(parseQty('1'));
    expect(h.ex.get('o2')!.filledQty).toBe(parseQty('0.5'));
  });

  it('folding the reordering window does not change awards for in-order prints', () => {
    const run = (maxTradeLagMs: number) => {
      const h = exchange('1', maxTradeLagMs);
      h.at(20, () => {
        h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('2') }, T0 + 20);
      });
      for (let t = 200; t <= 3000; t += 200) h.feed(print(t, t - 10, t % 800 === 0 ? '99.85' : '99.90', '0.3'));
      h.run();
      return h.fills().map((f) => [f.at - T0, f.qty, f.fillType]);
    };
    expect(run(50)).toEqual(run(100_000));
    expect(run(50).length).toBeGreaterThan(1);
  });

  it('refuses a print beyond the lag bound instead of matching it silently', () => {
    const h = exchange();
    h.at(20, () => {
      h.ex.submit({ clientId: 'c', side: 'buy', price: parsePrice('99.90'), qty: parseQty('1') }, T0 + 20);
    });
    h.run();
    expect(() => h.ex.onTrade(print(1000, 100, '99.85', '1'), T0 + 1000)).toThrow(/maxTradeLagMs/);
    const discarded = print(1000, 100, '99.85', '1');
    h.ex.noteDiscardedTrade(discarded, T0 + 1000);
    const unc = h.events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill_uncertain' }> => e.kind === 'fill_uncertain');
    expect(unc.map((u) => [u.order.orderId, u.reason])).toEqual([['o1', 'stale_print_discarded']]);
    expect(h.fills()).toHaveLength(0);
  });
});

function exchange(bidSize = '2', maxTradeLagMs = 500) {
  const scheduler = new Scheduler();
  const events: ExecutionEvent[] = [];
  let latest: BookEvent | null = null;
  const ex = new PaperExchange({ ...DEFAULT_EXECUTION, tickSize: TICK }, scheduler, (e) => events.push(e), () => latest, { maxTradeLagMs });
  scheduler.schedule(T0, Priority.MARKET, () => void (latest = book(0, bidSize)));
  return {
    ex,
    events,
    at: (t: number, fn: () => void) => scheduler.schedule(T0 + t, Priority.TICK, fn),
    feed: (tr: TradeEvent) => scheduler.schedule(tr.obsTime, Priority.MARKET, () => ex.onTrade(tr, tr.obsTime)),
    run: () => {
      for (let item = scheduler.pop(); item; item = scheduler.pop()) void item.run();
    },
    fills: () => events.filter((e): e is Extract<ExecutionEvent, { kind: 'fill' }> => e.kind === 'fill'),
    kinds: () => events.map((e) => e.kind),
  };
}
