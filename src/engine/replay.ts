/**
 * Two-clock replay engine.
 *
 *   fast clock:  policy tick every policyTickMs (sees observations with obsTime <= now)
 *   slow clock:  controller at every window boundary (sees the completed window's review)
 *
 * Everything runs on a single deterministic discrete-event scheduler in simulated time.
 * The engine never reads the wall clock into the ledger, so two runs of the same inputs
 * produce byte-identical ledgers.
 */
import { performance } from 'node:perf_hooks';
import {
  absBig,
  bpsOf,
  fmtMoney,
  fmtPrice,
  fmtQty,
  maxBig,
  minBig,
  mulDivHalfUp,
  notional,
} from '../core/money.js';
import { Priority, Scheduler } from '../core/scheduler.js';
import {
  INSTRUCTION_BOUNDS,
  initialInstruction,
  validateInstruction,
  type SteeringInstruction,
} from '../controller/instruction.js';
import type { ControllerContext, OutcomeHorizonStats, SteeringController, WindowRef, WindowReview } from '../controller/types.js';
import { EXECUTION_ASSUMPTIONS, FILL_UNCERTAINTY_NOTE, PaperExchange, openExposure, remainingQty, type ExecutionEvent } from '../execution/paper.js';
import { Ledger } from '../ledger/ledger.js';
import { SYNTHETIC_LABEL, fixtureContentHash, midPrice, type BookEvent, type Fixture, type MarketEvent } from '../market/events.js';
import { StreamValidator, checkStaleness } from '../market/validation.js';
import type { FastPolicy, PolicyDecision, PolicyInput, RestingView } from '../policy/types.js';
import { Portfolio, valuationToWire, type Mark } from '../portfolio/accounting.js';
import { RiskGate } from '../risk/gate.js';
import { configToWire, validateReplayConfig, type ReplayConfig } from './config.js';
import type { RunSummary, WindowRow } from './summary.js';

export interface ReplayDeps {
  fixture: Fixture;
  policy: FastPolicy;
  controller: SteeringController | null;
  config: ReplayConfig;
  /** Receives each ledger entry as a JSONL line as soon as it is appended. */
  ledgerSink?: (line: string) => void;
}

export interface ReplayResult {
  runId: string;
  ledger: Ledger;
  summary: RunSummary;
  /** Wall-clock diagnostics; deliberately kept out of the ledger. */
  diagnostics: { wallMs: number; controllerWallMs: number[] };
}

interface AcceptedInstruction {
  instruction: SteeringInstruction;
  readyAt: number;
}

interface HorizonAcc {
  count: number;
  sumMarkout: bigint;
  sumNotional: bigint;
  negativeCount: number;
}

interface WindowStats {
  index: number;
  start: number;
  end: number;
  instructionVersionsUsed: Set<number>;
  bookCount: number;
  tradeCount: number;
  tradeVolume: bigint;
  sellAggressorVolume: bigint;
  buyAggressorVolume: bigint;
  firstMid: bigint | null;
  lastMid: bigint | null;
  minMid: bigint | null;
  maxMid: bigint | null;
  spreadBpsSum: bigint;
  spreadSamples: number;
  rejectedObservations: number;
  ticks: number;
  quoteDecisions: number;
  holdDecisions: number;
  pullDecisions: number;
  ordersProposed: number;
  ordersSubmitted: number;
  ordersRejectedByRisk: number;
  ordersRejectedByVenue: number;
  cancelsRequested: number;
  cancelFillRaces: number;
  fills: number;
  fillQty: bigint;
  buyFillQty: bigint;
  sellFillQty: bigint;
  partialFills: number;
  queueConsumedWithoutFill: number;
  outcomes: Map<number, HorizonAcc>;
}

interface FillRecord {
  fillId: string;
  orderId: string;
  side: 'buy' | 'sell';
  price: bigint;
  qty: bigint;
  time: number;
}

function newHorizonAcc(): HorizonAcc {
  return { count: 0, sumMarkout: 0n, sumNotional: 0n, negativeCount: 0 };
}

function horizonStats(horizonMs: number, acc: HorizonAcc | undefined): OutcomeHorizonStats {
  const a = acc ?? newHorizonAcc();
  return {
    horizonMs,
    count: a.count,
    sumMarkout: fmtMoney(a.sumMarkout),
    avgMarkoutBps: fmtMoney(bpsOf(a.sumMarkout, a.sumNotional)),
    negativeCount: a.negativeCount,
  };
}

export async function replay(deps: ReplayDeps): Promise<ReplayResult> {
  return new ReplayEngine(deps).run();
}

class ReplayEngine {
  private readonly cfg: ReplayConfig;
  private readonly fixture: Fixture;
  private readonly policy: FastPolicy;
  private readonly controller: SteeringController | null;
  private readonly ledger: Ledger;
  private readonly scheduler = new Scheduler();
  private readonly portfolio: Portfolio;
  private readonly gate: RiskGate;
  private readonly exchange: PaperExchange;

  private readonly start: number;
  private readonly end: number;
  private readonly numWindows: number;
  private now: number;

  private latestBook: BookEvent | null = null;
  private readonly accepted: AcceptedInstruction[] = [];
  private win: WindowStats;
  private readonly windowRows: WindowRow[] = [];
  private readonly fills: FillRecord[] = [];
  private fillSeq = 0;
  private pendingOutcomes = 0;
  private readonly cumulativeOutcomes = new Map<number, HorizonAcc>();
  private readonly controllerWallMs: number[] = [];

  private readonly totals = {
    ticks: 0,
    quote: 0,
    hold: 0,
    pull: 0,
    policyErrors: 0,
    proposed: 0,
    submitted: 0,
    rejectedRisk: 0,
    rejectedVenue: 0,
    cancelsRequested: 0,
    cancelsEffective: 0,
    cancelsTooLate: 0,
    cancelFillRaces: 0,
    fills: 0,
    partialFills: 0,
    tradeThrough: 0,
    queueExhausted: 0,
    queueConsumedWithoutFill: 0,
    observationsAccepted: 0,
    observationsRejected: 0,
    instructionsAccepted: 0,
    rejectedLate: 0,
    rejectedFailed: 0,
    rejectedInvalid: 0,
    outcomesUnmeasurable: 0,
  };

  constructor(deps: ReplayDeps) {
    validateReplayConfig(deps.config);
    this.cfg = deps.config;
    this.fixture = deps.fixture;
    this.policy = deps.policy;
    this.controller = deps.controller;
    this.ledger = new Ledger(deps.ledgerSink);
    this.portfolio = new Portfolio(this.cfg.initialCash);
    this.gate = new RiskGate(this.cfg.risk);
    this.exchange = new PaperExchange(this.cfg.execution, this.scheduler, (ev) => this.onExecutionEvent(ev), () => this.latestBook);

    const h = this.fixture.header;
    this.start = h.startTime;
    const coverable = Math.floor((h.endTime - h.startTime) / this.cfg.windowMs);
    this.numWindows = this.cfg.numWindows ?? coverable;
    if (this.numWindows < 1) throw new RangeError('fixture does not cover a full window');
    if (this.numWindows > coverable) throw new RangeError(`fixture covers only ${coverable} windows, ${this.numWindows} requested`);
    this.end = this.start + this.numWindows * this.cfg.windowMs;
    this.now = this.start;
    this.win = this.newWindowStats(0);
    this.accepted.push({ instruction: initialInstruction(this.start), readyAt: this.start });
  }

  async run(): Promise<ReplayResult> {
    const wallStart = performance.now();
    const h = this.fixture.header;
    this.ledger.append({
      type: 'replay_started',
      simTime: this.start,
      runId: this.cfg.runId,
      label: this.cfg.label,
      synthetic: h.synthetic,
      syntheticLabel: h.synthetic ? SYNTHETIC_LABEL : null,
      fixture: {
        symbol: h.symbol,
        venue: h.venue,
        contentHash: fixtureContentHash(this.fixture),
        eventCount: h.eventCount,
        startTime: h.startTime,
        endTime: h.endTime,
        provenance: h.provenance,
      },
      config: {
        ...(configToWire(this.cfg) as object),
        policyId: this.policy.id,
        controllerId: this.controller?.id ?? null,
        controllerKind: this.controller?.kind ?? null,
        numWindowsEffective: this.numWindows,
      },
      assumptions: [...EXECUTION_ASSUMPTIONS],
    });

    // Structural validation in file order; only structurally valid events are scheduled.
    const validator = new StreamValidator(h);
    for (const ev of this.fixture.events) {
      const verdict = validator.checkStructure(ev);
      if (!verdict.ok) {
        this.totals.observationsRejected++;
        this.ledger.append({
          type: 'observation_rejected',
          simTime: this.start,
          eventId: ev.eventId,
          seq: ev.seq,
          obsTime: ev.obsTime,
          marketTime: ev.marketTime,
          reason: verdict.reason,
          detail: verdict.detail,
          phase: 'structural',
        });
        continue;
      }
      if (ev.obsTime < this.start || ev.obsTime > this.end) {
        this.totals.observationsRejected++;
        this.ledger.append({
          type: 'observation_rejected',
          simTime: this.start,
          eventId: ev.eventId,
          seq: ev.seq,
          obsTime: ev.obsTime,
          marketTime: ev.marketTime,
          reason: 'outside_replay_range',
          detail: `obsTime outside [${this.start}, ${this.end}]`,
          phase: 'structural',
        });
        continue;
      }
      this.scheduler.schedule(ev.obsTime, Priority.MARKET, () => this.onMarketEvent(ev));
    }

    for (let k = 1; k <= this.numWindows; k++) {
      this.scheduler.schedule(this.start + k * this.cfg.windowMs, Priority.WINDOW, () => this.onWindowBoundary(k - 1));
    }
    const tickCount = (this.numWindows * this.cfg.windowMs) / this.cfg.policyTickMs;
    for (let i = 0; i < tickCount; i++) {
      this.scheduler.schedule(this.start + i * this.cfg.policyTickMs, Priority.TICK, () => this.onTick(i));
    }

    for (;;) {
      const item = this.scheduler.pop();
      if (!item) break;
      if (item.time > this.end) break;
      if (item.time < this.now) throw new Error(`clock went backwards: ${item.time} < ${this.now}`);
      this.now = item.time;
      await item.run();
    }
    this.now = this.end;

    const summary = this.buildSummary();
    this.ledger.append({ type: 'replay_finished', simTime: this.end, runId: this.cfg.runId, summary });
    return {
      runId: this.cfg.runId,
      ledger: this.ledger,
      summary: { ...summary, ledger: { entries: this.ledger.length, headHash: this.ledger.headHash } },
      diagnostics: { wallMs: performance.now() - wallStart, controllerWallMs: this.controllerWallMs },
    };
  }

  // ---------------------------------------------------------------- market

  private onMarketEvent(ev: MarketEvent): void {
    const stale = checkStaleness(ev, this.cfg.maxStalenessMs);
    if (!stale.ok) {
      this.totals.observationsRejected++;
      this.win.rejectedObservations++;
      this.ledger.append({
        type: 'observation_rejected',
        simTime: this.now,
        eventId: ev.eventId,
        seq: ev.seq,
        obsTime: ev.obsTime,
        marketTime: ev.marketTime,
        reason: stale.reason,
        detail: stale.detail,
        phase: 'content',
      });
      return;
    }
    this.totals.observationsAccepted++;
    if (ev.type === 'book') {
      const bb = ev.bids[0];
      const ba = ev.asks[0];
      this.ledger.append({
        type: 'observation',
        simTime: this.now,
        eventId: ev.eventId,
        seq: ev.seq,
        kind: 'book',
        obsTime: ev.obsTime,
        marketTime: ev.marketTime,
        feedLagMs: ev.obsTime - ev.marketTime,
        bestBid: bb ? fmtPrice(bb.price) : null,
        bestAsk: ba ? fmtPrice(ba.price) : null,
        bidSize: bb ? fmtQty(bb.size) : null,
        askSize: ba ? fmtQty(ba.size) : null,
        price: null,
        size: null,
        aggressor: null,
      });
      this.latestBook = ev;
      this.win.bookCount++;
      const mid = midPrice(ev);
      if (mid !== null && bb && ba) {
        if (this.win.firstMid === null) this.win.firstMid = mid;
        this.win.lastMid = mid;
        this.win.minMid = this.win.minMid === null ? mid : minBig(this.win.minMid, mid);
        this.win.maxMid = this.win.maxMid === null ? mid : maxBig(this.win.maxMid, mid);
        this.win.spreadBpsSum += bpsOf(ba.price - bb.price, mid);
        this.win.spreadSamples++;
      }
      return;
    }
    this.ledger.append({
      type: 'observation',
      simTime: this.now,
      eventId: ev.eventId,
      seq: ev.seq,
      kind: 'trade',
      obsTime: ev.obsTime,
      marketTime: ev.marketTime,
      feedLagMs: ev.obsTime - ev.marketTime,
      bestBid: null,
      bestAsk: null,
      bidSize: null,
      askSize: null,
      price: fmtPrice(ev.price),
      size: fmtQty(ev.size),
      aggressor: ev.aggressor,
    });
    this.win.tradeCount++;
    this.win.tradeVolume += ev.size;
    if (ev.aggressor === 'sell') this.win.sellAggressorVolume += ev.size;
    if (ev.aggressor === 'buy') this.win.buyAggressorVolume += ev.size;
    this.exchange.onTrade(ev, this.now);
  }

  // ------------------------------------------------------------- execution

  private onExecutionEvent(ev: ExecutionEvent): void {
    const o = ev.order;
    switch (ev.kind) {
      case 'order_submitted': {
        this.totals.submitted++;
        this.win.ordersSubmitted++;
        this.ledger.append({
          type: 'order_submitted',
          simTime: this.now,
          orderId: o.orderId,
          clientId: o.clientId,
          side: o.side,
          price: fmtPrice(o.price),
          qty: fmtQty(o.qty),
          submittedAt: ev.at,
          expectedLiveAt: o.liveAt,
          placementCost: fmtMoney(ev.cost),
        });
        this.chargeTx(o.orderId, 'placement', ev.cost);
        return;
      }
      case 'order_live':
        this.ledger.append({
          type: 'order_live',
          simTime: this.now,
          orderId: o.orderId,
          side: o.side,
          price: fmtPrice(o.price),
          qty: fmtQty(o.qty),
          liveAt: ev.at,
          queueAhead: fmtQty(o.queueAhead),
          queueSource: 'displayed size at our price level in latest book at live time (0 if level absent)',
          bookEventId: o.queueBookEventId,
          fillUncertainty: FILL_UNCERTAINTY_NOTE,
        });
        return;
      case 'order_rejected':
        this.totals.rejectedVenue++;
        this.win.ordersRejectedByVenue++;
        this.ledger.append({
          type: 'order_rejected',
          simTime: this.now,
          clientId: o.clientId,
          orderId: o.orderId,
          side: o.side,
          price: fmtPrice(o.price),
          qty: fmtQty(o.qty),
          rejectedBy: 'venue',
          reason: ev.reason,
          detail: ev.detail,
        });
        return;
      case 'cancel_requested':
        this.totals.cancelsRequested++;
        this.win.cancelsRequested++;
        this.ledger.append({
          type: 'cancel_requested',
          simTime: this.now,
          orderId: o.orderId,
          requestedAt: ev.at,
          expectedEffectiveAt: ev.effectiveAt,
          cancelCost: fmtMoney(ev.cost),
          reason: ev.reason,
        });
        this.chargeTx(o.orderId, 'cancel', ev.cost);
        return;
      case 'cancel_effective':
        this.totals.cancelsEffective++;
        this.ledger.append({
          type: 'cancel_effective',
          simTime: this.now,
          orderId: o.orderId,
          remainingQty: fmtQty(remainingQty(o)),
          filledQty: fmtQty(o.filledQty),
        });
        return;
      case 'cancel_too_late':
        this.totals.cancelsTooLate++;
        this.ledger.append({ type: 'cancel_too_late', simTime: this.now, orderId: o.orderId, reason: ev.reason });
        return;
      case 'cancel_fill_race':
        this.totals.cancelFillRaces++;
        this.win.cancelFillRaces++;
        this.ledger.append({
          type: 'cancel_fill_race',
          simTime: this.now,
          orderId: o.orderId,
          tradeEventId: ev.trade.eventId,
          cancelRequestedAt: o.cancelRequestedAt ?? -1,
          cancelEffectiveAt: o.cancelEffectiveAt ?? -1,
          tradeObsTime: ev.trade.obsTime,
          outcome: 'fill_wins',
          rule: 'trade processed before cancel takes effect (cancelEffectiveAt >= trade obsTime)',
        });
        return;
      case 'queue_consumed':
        this.totals.queueConsumedWithoutFill++;
        this.win.queueConsumedWithoutFill++;
        this.ledger.append({
          type: 'queue_consumed',
          simTime: this.now,
          orderId: o.orderId,
          tradeEventId: ev.trade.eventId,
          tradeSize: fmtQty(ev.trade.size),
          queueAheadBefore: fmtQty(ev.queueAheadBefore),
          queueAheadAfter: fmtQty(o.queueAhead),
          note: 'trade at our price consumed by displayed queue ahead of us; no fill awarded',
        });
        return;
      case 'fill':
        this.onFill(ev);
        return;
      default:
        return;
    }
  }

  private chargeTx(orderId: string, kind: 'placement' | 'cancel', amount: bigint): void {
    if (amount === 0n) return;
    const cashAfter = this.portfolio.applyTxCost(amount);
    this.ledger.append({ type: 'tx_cost', simTime: this.now, orderId, kind, amount: fmtMoney(amount), cashAfter: fmtMoney(cashAfter) });
  }

  private onFill(ev: Extract<ExecutionEvent, { kind: 'fill' }>): void {
    const o = ev.order;
    const fillId = `f${++this.fillSeq}`;
    const app = this.portfolio.applyFill(o.side, o.price, ev.qty, ev.fee);
    this.totals.fills++;
    this.win.fills++;
    this.win.fillQty += ev.qty;
    if (o.side === 'buy') this.win.buyFillQty += ev.qty;
    else this.win.sellFillQty += ev.qty;
    const isPartial = o.filledQty < o.qty;
    if (isPartial) {
      this.totals.partialFills++;
      this.win.partialFills++;
    }
    if (ev.fillType === 'trade_through') this.totals.tradeThrough++;
    else this.totals.queueExhausted++;
    this.ledger.append({
      type: 'fill',
      simTime: this.now,
      fillId,
      orderId: o.orderId,
      side: o.side,
      price: fmtPrice(o.price),
      qty: fmtQty(ev.qty),
      notional: fmtMoney(ev.notional),
      fee: fmtMoney(ev.fee),
      isPartial,
      remainingQty: fmtQty(remainingQty(o)),
      tradeEventId: ev.trade.eventId,
      tradePrice: fmtPrice(ev.trade.price),
      tradeSize: fmtQty(ev.trade.size),
      fillType: ev.fillType,
      queueAheadBefore: fmtQty(ev.queueAheadBefore),
      duringCancelPending: ev.duringCancelPending,
      realizedDelta: fmtMoney(app.realizedDelta),
      inventoryAfter: fmtQty(app.inventoryAfter),
      cashAfter: fmtMoney(app.cashAfter),
    });
    const rec: FillRecord = { fillId, orderId: o.orderId, side: o.side, price: o.price, qty: ev.qty, time: this.now };
    this.fills.push(rec);
    for (const h of this.cfg.outcomeHorizonsMs) {
      const at = this.now + h;
      this.pendingOutcomes++;
      if (at <= this.end) this.scheduler.schedule(at, Priority.OUTCOME, () => this.measureOutcome(rec, h));
    }
    this.checkLossLimit();
  }

  private measureOutcome(fill: FillRecord, horizonMs: number): void {
    this.pendingOutcomes--;
    const book = this.latestBook;
    const mid = book ? midPrice(book) : null;
    const fillNotional = notional(fill.price, fill.qty);
    if (!book || mid === null) {
      this.totals.outcomesUnmeasurable++;
      this.ledger.append({
        type: 'outcome',
        simTime: this.now,
        fillId: fill.fillId,
        orderId: fill.orderId,
        side: fill.side,
        fillTime: fill.time,
        horizonMs,
        availableAt: this.now,
        fillPrice: fmtPrice(fill.price),
        qty: fmtQty(fill.qty),
        midAtHorizon: null,
        midEventId: null,
        markout: null,
        markoutBps: null,
        status: 'unmeasurable_no_book',
      });
      return;
    }
    const midValue = notional(mid, fill.qty);
    const markout = fill.side === 'buy' ? midValue - fillNotional : fillNotional - midValue;
    const markoutBps = bpsOf(markout, fillNotional);
    for (const map of [this.win.outcomes, this.cumulativeOutcomes]) {
      const acc = map.get(horizonMs) ?? newHorizonAcc();
      acc.count++;
      acc.sumMarkout += markout;
      acc.sumNotional += fillNotional;
      if (markout < 0n) acc.negativeCount++;
      map.set(horizonMs, acc);
    }
    this.ledger.append({
      type: 'outcome',
      simTime: this.now,
      fillId: fill.fillId,
      orderId: fill.orderId,
      side: fill.side,
      fillTime: fill.time,
      horizonMs,
      availableAt: this.now,
      fillPrice: fmtPrice(fill.price),
      qty: fmtQty(fill.qty),
      midAtHorizon: fmtPrice(mid),
      midEventId: book.eventId,
      markout: fmtMoney(markout),
      markoutBps: fmtMoney(markoutBps),
      status: 'measured',
    });
  }

  private currentMark(): Mark | null {
    const b = this.latestBook;
    const bb = b?.bids[0];
    const ba = b?.asks[0];
    if (!b || !bb || !ba) return null;
    return { bestBid: bb.price, bestAsk: ba.price };
  }

  private checkLossLimit(): void {
    const v = this.portfolio.valuation(this.currentMark());
    if (this.gate.checkLoss(v.netPnl, this.now)) {
      this.ledger.append({
        type: 'risk_breach',
        simTime: this.now,
        kind: 'loss_limit',
        detail: this.gate.killSwitchDetail ?? '',
        netPnl: fmtMoney(v.netPnl),
        limit: fmtMoney(-this.cfg.risk.maxLoss),
        action: 'kill switch: cancel all open orders, reject all new orders for the rest of the run',
      });
      for (const o of this.exchange.openOrders()) this.exchange.requestCancel(o.orderId, this.now, 'kill_switch');
    }
  }

  // ------------------------------------------------------------ fast clock

  private activeInstruction(now: number): SteeringInstruction {
    for (let i = this.accepted.length - 1; i >= 0; i--) {
      const a = this.accepted[i]!;
      if (a.readyAt <= now) return a.instruction;
    }
    return this.accepted[0]!.instruction;
  }

  private restingView(side: 'buy' | 'sell'): RestingView | null {
    const o = this.exchange.restingOn(side)[0];
    if (!o) return null;
    return { orderId: o.orderId, price: o.price, qty: o.qty, remainingQty: remainingQty(o), state: o.state === 'pending' ? 'pending' : 'live' };
  }

  private onTick(tick: number): void {
    const window = this.win.index;
    const instruction = this.activeInstruction(this.now);
    this.win.instructionVersionsUsed.add(instruction.version);
    this.checkLossLimit();

    const book = this.latestBook;
    const bb = book?.bids[0];
    const ba = book?.asks[0];
    const bookView =
      book && bb && ba
        ? {
            eventId: book.eventId,
            obsTime: book.obsTime,
            marketTime: book.marketTime,
            bestBid: bb.price,
            bestAsk: ba.price,
            bidSize: bb.size,
            askSize: ba.size,
            mid: (bb.price + ba.price) / 2n,
          }
        : null;
    const input: PolicyInput = {
      now: this.now,
      tick,
      window,
      book: bookView,
      bookAgeMs: bookView ? this.now - bookView.obsTime : null,
      inventory: this.portfolio.inventory,
      maxPosition: this.cfg.risk.maxPosition,
      instruction,
      resting: { bid: this.restingView('buy'), ask: this.restingView('sell') },
    };

    let decision: PolicyDecision;
    let policyError: string | undefined;
    try {
      decision = this.policy.decide(input);
    } catch (err) {
      policyError = err instanceof Error ? err.message : String(err);
      decision = { intent: 'pull', bid: null, ask: null, reason: `policy error: ${policyError}` };
      this.totals.policyErrors++;
    }

    this.totals.ticks++;
    this.win.ticks++;
    if (decision.intent === 'quote') {
      this.totals.quote++;
      this.win.quoteDecisions++;
    } else if (decision.intent === 'hold') {
      this.totals.hold++;
      this.win.holdDecisions++;
    } else {
      this.totals.pull++;
      this.win.pullDecisions++;
    }

    const restingWire = (r: RestingView | null) => (r ? { orderId: r.orderId, price: fmtPrice(r.price), qty: fmtQty(r.qty) } : null);
    const quoteWire = (q: { price: bigint; qty: bigint } | null) => (q ? { price: fmtPrice(q.price), qty: fmtQty(q.qty) } : null);
    this.ledger.append({
      type: 'policy_decision',
      simTime: this.now,
      tick,
      window,
      policyId: this.policy.id,
      instructionVersion: instruction.version,
      instructionEffectiveFrom: instruction.effectiveFrom,
      input: {
        bookEventId: bookView?.eventId ?? null,
        bookObsTime: bookView?.obsTime ?? null,
        bookAgeMs: input.bookAgeMs,
        bestBid: bookView ? fmtPrice(bookView.bestBid) : null,
        bestAsk: bookView ? fmtPrice(bookView.bestAsk) : null,
        inventory: fmtQty(input.inventory),
        restingBid: restingWire(input.resting.bid),
        restingAsk: restingWire(input.resting.ask),
      },
      decision: { intent: decision.intent, bid: quoteWire(decision.bid), ask: quoteWire(decision.ask), reason: decision.reason },
      ...(policyError !== undefined ? { policyError } : {}),
    });

    this.reconcile(decision, tick);
  }

  private reconcile(decision: PolicyDecision, tick: number): void {
    if (decision.intent === 'hold') return;
    if (decision.intent === 'pull') {
      for (const o of this.exchange.openOrders()) this.exchange.requestCancel(o.orderId, this.now, 'pull');
      return;
    }
    for (const side of ['buy', 'sell'] as const) {
      const desired = side === 'buy' ? decision.bid : decision.ask;
      const resting = this.exchange.restingOn(side);
      const keep = desired ? resting.find((o) => o.price === desired.price && o.qty === desired.qty) : undefined;
      for (const o of resting) {
        if (o !== keep) this.exchange.requestCancel(o.orderId, this.now, desired ? 'requote' : 'withdraw');
      }
      if (desired && !keep) this.propose(side, desired, tick);
    }
  }

  private propose(side: 'buy' | 'sell', q: { price: bigint; qty: bigint }, tick: number): void {
    const clientId = `c${tick}-${side}`;
    this.totals.proposed++;
    this.win.ordersProposed++;
    this.ledger.append({ type: 'order_proposed', simTime: this.now, clientId, side, price: fmtPrice(q.price), qty: fmtQty(q.qty), tick });
    const exposure = openExposure(this.exchange.openOrders());
    const verdict = this.gate.checkOrder({ side, price: q.price, qty: q.qty }, { inventory: this.portfolio.inventory, ...exposure });
    if (!verdict.ok) {
      this.totals.rejectedRisk++;
      this.win.ordersRejectedByRisk++;
      this.ledger.append({
        type: 'order_rejected',
        simTime: this.now,
        clientId,
        orderId: null,
        side,
        price: fmtPrice(q.price),
        qty: fmtQty(q.qty),
        rejectedBy: 'risk_gate',
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return;
    }
    this.exchange.submit({ clientId, side, price: q.price, qty: q.qty }, this.now);
  }

  // ------------------------------------------------------------ slow clock

  private newWindowStats(index: number): WindowStats {
    const start = this.start + index * this.cfg.windowMs;
    return {
      index,
      start,
      end: start + this.cfg.windowMs,
      instructionVersionsUsed: new Set(),
      bookCount: 0,
      tradeCount: 0,
      tradeVolume: 0n,
      sellAggressorVolume: 0n,
      buyAggressorVolume: 0n,
      firstMid: null,
      lastMid: null,
      minMid: null,
      maxMid: null,
      spreadBpsSum: 0n,
      spreadSamples: 0,
      rejectedObservations: 0,
      ticks: 0,
      quoteDecisions: 0,
      holdDecisions: 0,
      pullDecisions: 0,
      ordersProposed: 0,
      ordersSubmitted: 0,
      ordersRejectedByRisk: 0,
      ordersRejectedByVenue: 0,
      cancelsRequested: 0,
      cancelFillRaces: 0,
      fills: 0,
      fillQty: 0n,
      buyFillQty: 0n,
      sellFillQty: 0n,
      partialFills: 0,
      queueConsumedWithoutFill: 0,
      outcomes: new Map(),
    };
  }

  private buildReview(w: WindowStats): WindowReview {
    const v = this.portfolio.valuation(this.currentMark());
    const inEffect = this.activeInstruction(w.end);
    const maxPos = this.cfg.risk.maxPosition;
    const midChangeBps = w.firstMid !== null && w.lastMid !== null ? bpsOf(w.lastMid - w.firstMid, w.firstMid) : null;
    return {
      runId: this.cfg.runId,
      window: { index: w.index, start: w.start, end: w.end },
      instructionVersionsUsed: [...w.instructionVersionsUsed].sort((a, b) => a - b),
      paramsInEffectAtEnd: { ...inEffect.params },
      market: {
        bookCount: w.bookCount,
        tradeCount: w.tradeCount,
        tradeVolume: fmtQty(w.tradeVolume),
        sellAggressorVolume: fmtQty(w.sellAggressorVolume),
        buyAggressorVolume: fmtQty(w.buyAggressorVolume),
        firstMid: w.firstMid === null ? null : fmtPrice(w.firstMid),
        lastMid: w.lastMid === null ? null : fmtPrice(w.lastMid),
        minMid: w.minMid === null ? null : fmtPrice(w.minMid),
        maxMid: w.maxMid === null ? null : fmtPrice(w.maxMid),
        midChangeBps: midChangeBps === null ? null : midChangeBps.toString(),
        avgSpreadBps: w.spreadSamples === 0 ? null : (w.spreadBpsSum / BigInt(w.spreadSamples)).toString(),
        lastBookAgeMs: this.latestBook ? w.end - this.latestBook.obsTime : null,
        rejectedObservations: w.rejectedObservations,
      },
      activity: {
        ticks: w.ticks,
        quoteDecisions: w.quoteDecisions,
        holdDecisions: w.holdDecisions,
        pullDecisions: w.pullDecisions,
        ordersProposed: w.ordersProposed,
        ordersSubmitted: w.ordersSubmitted,
        ordersRejectedByRisk: w.ordersRejectedByRisk,
        ordersRejectedByVenue: w.ordersRejectedByVenue,
        cancelsRequested: w.cancelsRequested,
        cancelFillRaces: w.cancelFillRaces,
        fills: w.fills,
        fillQty: fmtQty(w.fillQty),
        buyFillQty: fmtQty(w.buyFillQty),
        sellFillQty: fmtQty(w.sellFillQty),
        partialFills: w.partialFills,
        queueConsumedWithoutFill: w.queueConsumedWithoutFill,
      },
      outcomes: {
        horizonsMs: [...this.cfg.outcomeHorizonsMs],
        measuredThisWindow: this.cfg.outcomeHorizonsMs.map((h) => horizonStats(h, w.outcomes.get(h))),
        pendingAtWindowEnd: this.pendingOutcomes,
        cumulative: this.cfg.outcomeHorizonsMs.map((h) => horizonStats(h, this.cumulativeOutcomes.get(h))),
      },
      portfolio: {
        ...valuationToWire(v),
        maxAbsInventory: fmtQty(this.portfolio.maxAbsInventory),
        fillCountCumulative: this.portfolio.fillCount,
      },
      risk: {
        maxPosition: fmtQty(maxPos),
        maxLoss: fmtMoney(this.cfg.risk.maxLoss),
        positionUtilizationMilli: Number(mulDivHalfUp(absBig(v.inventory), 1000n, maxPos)),
        killSwitchActive: this.gate.killSwitch,
      },
    };
  }

  private async onWindowBoundary(k: number): Promise<void> {
    const w = this.win;
    if (w.index !== k) throw new Error(`window bookkeeping mismatch: expected ${k}, have ${w.index}`);
    const review = this.buildReview(w);
    const v = this.portfolio.valuation(this.currentMark());
    this.ledger.append({
      type: 'window_summary',
      simTime: this.now,
      window: k,
      start: w.start,
      end: w.end,
      instructionVersionsUsed: review.instructionVersionsUsed,
      paramsInEffectAtEnd: review.paramsInEffectAtEnd,
      fills: w.fills,
      fillQty: fmtQty(w.fillQty),
      ordersSubmitted: w.ordersSubmitted,
      ordersRejected: w.ordersRejectedByRisk + w.ordersRejectedByVenue,
      cancels: w.cancelsRequested,
      netPnl: fmtMoney(v.netPnl),
      inventory: fmtQty(v.inventory),
    });
    this.windowRows.push({
      window: k,
      start: w.start,
      end: w.end,
      instructionVersionsUsed: review.instructionVersionsUsed,
      params: review.paramsInEffectAtEnd,
      ticks: w.ticks,
      ordersSubmitted: w.ordersSubmitted,
      ordersRejectedByRisk: w.ordersRejectedByRisk,
      cancels: w.cancelsRequested,
      fills: w.fills,
      fillQty: fmtQty(w.fillQty),
      markoutShortest: review.outcomes.measuredThisWindow[0]?.sumMarkout ?? null,
      netPnl: fmtMoney(v.netPnl),
      inventory: fmtQty(v.inventory),
      midChangeBps: review.market.midChangeBps,
    });
    this.ledger.append({ type: 'controller_input', simTime: this.now, window: k, review });

    const prior = this.accepted[this.accepted.length - 1]!.instruction;
    if (k + 1 >= this.numWindows) {
      this.ledger.append({ type: 'controller_skipped', simTime: this.now, window: k, reason: 'no_next_window', instructionVersion: prior.version });
      return;
    }
    const nextWindow: WindowRef = { index: k + 1, start: w.end, end: w.end + this.cfg.windowMs };
    this.win = this.newWindowStats(k + 1);

    if (this.cfg.steering === 'disabled' || !this.controller) {
      this.ledger.append({ type: 'controller_skipped', simTime: this.now, window: k, reason: 'steering_disabled', instructionVersion: prior.version });
      return;
    }

    const ctx: ControllerContext = {
      priorInstruction: prior,
      nextWindow,
      nextVersion: prior.version + 1,
      bounds: INSTRUCTION_BOUNDS,
      deadlineMs: this.cfg.controllerDeadlineMs,
    };
    const deadlineAt = nextWindow.start + this.cfg.controllerDeadlineMs;
    const wall0 = performance.now();
    let proposal;
    try {
      proposal = await this.controller.decide(review, ctx);
    } catch (err) {
      this.controllerWallMs.push(performance.now() - wall0);
      this.totals.rejectedFailed++;
      this.ledger.append({
        type: 'instruction_rejected',
        simTime: this.now,
        window: k,
        reason: 'controller_failed',
        detail: err instanceof Error ? err.message : String(err),
        readyAt: null,
        deadlineAt,
        keptInstructionVersion: prior.version,
      });
      return;
    }
    this.controllerWallMs.push(performance.now() - wall0);

    const latency = proposal.simulatedLatencyMs ?? this.controller.modeledLatencyMs;
    const latencyValid = Number.isInteger(latency) && latency >= 0;
    const readyAt = latencyValid ? this.now + latency : this.now;
    this.ledger.append({
      type: 'controller_output',
      simTime: this.now,
      window: k,
      controllerId: this.controller.id,
      proposal: { instruction: proposal.instruction, rationale: proposal.rationale ?? null },
      simulatedLatencyMs: latencyValid ? latency : -1,
      readyAt,
    });
    if (!latencyValid) {
      this.totals.rejectedInvalid++;
      this.ledger.append({
        type: 'instruction_rejected',
        simTime: this.now,
        window: k,
        reason: 'invalid',
        detail: `simulatedLatencyMs must be a non-negative integer, got ${String(latency)}`,
        readyAt: null,
        deadlineAt,
        keptInstructionVersion: prior.version,
      });
      return;
    }
    if (readyAt > deadlineAt) {
      this.totals.rejectedLate++;
      this.ledger.append({
        type: 'instruction_rejected',
        simTime: this.now,
        window: k,
        reason: 'late',
        detail: `ready at ${readyAt} after deadline ${deadlineAt} (latency ${latency}ms > ${this.cfg.controllerDeadlineMs}ms)`,
        readyAt,
        deadlineAt,
        keptInstructionVersion: prior.version,
      });
      return;
    }
    const validation = validateInstruction(proposal.instruction, {
      version: ctx.nextVersion,
      effectiveFrom: nextWindow.start,
      basedOnWindow: k,
    });
    if (!validation.ok) {
      this.totals.rejectedInvalid++;
      this.ledger.append({
        type: 'instruction_rejected',
        simTime: this.now,
        window: k,
        reason: 'invalid',
        detail: validation.errors.join('; '),
        readyAt,
        deadlineAt,
        keptInstructionVersion: prior.version,
      });
      return;
    }
    this.accepted.push({ instruction: validation.instruction, readyAt });
    this.totals.instructionsAccepted++;
    this.ledger.append({
      type: 'instruction_accepted',
      simTime: this.now,
      instruction: validation.instruction,
      readyAt,
      deadlineAt,
      appliesFrom: Math.max(validation.instruction.effectiveFrom, readyAt),
    });
  }

  // --------------------------------------------------------------- summary

  private buildSummary(): RunSummary {
    const h = this.fixture.header;
    const v = this.portfolio.valuation(this.currentMark());
    const t = this.totals;
    return {
      runId: this.cfg.runId,
      label: this.cfg.label,
      synthetic: h.synthetic,
      syntheticLabel: h.synthetic ? SYNTHETIC_LABEL : null,
      disclaimer: 'Synthetic research output from a paper execution model. Not evidence of profitability.',
      fixture: {
        symbol: h.symbol,
        venue: h.venue,
        contentHash: fixtureContentHash(this.fixture),
        eventCount: h.eventCount,
        seed: h.provenance.seed ?? null,
        generator: h.provenance.generator ?? null,
      },
      policyId: this.policy.id,
      steering: this.cfg.steering,
      controllerId: this.cfg.steering === 'enabled' && this.controller ? this.controller.id : null,
      windows: this.numWindows,
      windowMs: this.cfg.windowMs,
      policyTickMs: this.cfg.policyTickMs,
      ticks: t.ticks,
      decisions: { quote: t.quote, hold: t.hold, pull: t.pull, policyErrors: t.policyErrors },
      orders: {
        proposed: t.proposed,
        submitted: t.submitted,
        rejectedByRisk: t.rejectedRisk,
        rejectedByVenue: t.rejectedVenue,
        cancelsRequested: t.cancelsRequested,
        cancelsEffective: t.cancelsEffective,
        cancelsTooLate: t.cancelsTooLate,
        cancelFillRaces: t.cancelFillRaces,
      },
      fills: {
        count: t.fills,
        qty: fmtQty(this.portfolio.buyQty + this.portfolio.sellQty),
        buyQty: fmtQty(this.portfolio.buyQty),
        sellQty: fmtQty(this.portfolio.sellQty),
        buyNotional: fmtMoney(this.portfolio.buyNotional),
        sellNotional: fmtMoney(this.portfolio.sellNotional),
        partial: t.partialFills,
        tradeThrough: t.tradeThrough,
        queueExhausted: t.queueExhausted,
      },
      fillUncertainty: {
        model: 'pessimistic_back_of_queue',
        note: FILL_UNCERTAINTY_NOTE,
        queueConsumedWithoutFill: t.queueConsumedWithoutFill,
      },
      outcomes: this.cfg.outcomeHorizonsMs.map((hz) => horizonStats(hz, this.cumulativeOutcomes.get(hz))),
      outcomesPendingAtEnd: this.pendingOutcomes,
      outcomesUnmeasurable: t.outcomesUnmeasurable,
      portfolio: { ...valuationToWire(v), maxAbsInventory: fmtQty(this.portfolio.maxAbsInventory), initialCash: fmtMoney(this.portfolio.initialCash) },
      instructions: {
        accepted: t.instructionsAccepted,
        rejectedLate: t.rejectedLate,
        rejectedFailed: t.rejectedFailed,
        rejectedInvalid: t.rejectedInvalid,
        finalVersion: this.accepted[this.accepted.length - 1]!.instruction.version,
        history: this.accepted.map((a) => ({
          version: a.instruction.version,
          controllerId: a.instruction.controllerId,
          basedOnWindow: a.instruction.basedOnWindow,
          effectiveFrom: a.instruction.effectiveFrom,
          readyAt: a.readyAt,
          params: { ...a.instruction.params },
          reason: a.instruction.reason,
        })),
      },
      risk: {
        killSwitchTripped: this.gate.killSwitch,
        killSwitchAt: this.gate.killSwitchAt,
        maxPosition: fmtQty(this.cfg.risk.maxPosition),
        maxLoss: fmtMoney(this.cfg.risk.maxLoss),
      },
      observations: { accepted: t.observationsAccepted, rejected: t.observationsRejected },
      windowRows: this.windowRows,
      assumptions: [...EXECUTION_ASSUMPTIONS],
      ledger: { entries: this.ledger.length, headHash: '' },
    };
  }
}

