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
import { StreamValidator, checkStaleness, reject as rejectObservation, type Rejection } from '../market/validation.js';
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
  lateFillsAfterCancel: number;
  fillsIneligible: number;
  outcomes: Map<number, HorizonAcc>;
}

/**
 * A portion of a booked fill with a single source print. A fill starts as one portion; a
 * re-attribution moves quantity into a new portion with the actual source print and venue time.
 */
interface FillPortion {
  portionId: string;
  fillId: string;
  orderId: string;
  side: 'buy' | 'sell';
  price: bigint;
  qty: bigint;
  sourceTradeEventId: string;
  /** Venue time of the source print; outcome horizons run from here. */
  sourceMarketTime: number;
  /** Sim time the portion was booked or re-attributed. */
  observedAt: number;
  measured: Set<number>;
  /** Horizons scheduled and still counted as pending. */
  pending: Set<number>;
}

interface BookRef {
  eventId: string;
  obsTime: number;
  marketTime: number;
  mid: bigint;
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
  /** Every accepted two-sided book, for venue-time outcome measurement. */
  private readonly bookHistory: BookRef[] = [];
  private readonly validator: StreamValidator;
  private fileIndex = 0;
  private consumedEvents = 0;
  private readonly accepted: AcceptedInstruction[] = [];
  private win: WindowStats;
  private readonly windowRows: WindowRow[] = [];
  private readonly portions: FillPortion[] = [];
  private fillSeq = 0;
  private portionSeq = 0;
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
    establishedByReordering: 0,
    reattributed: 0,
    queueConsumedWithoutFill: 0,
    observationsAccepted: 0,
    observationsRejected: 0,
    instructionsAccepted: 0,
    rejectedLate: 0,
    rejectedFailed: 0,
    rejectedInvalid: 0,
    outcomesUnmeasurable: 0,
    lateFillsAfterCancel: 0,
    fillsIneligible: 0,
    ineligiblePredatesActivation: 0,
    ineligibleAtActivationInstant: 0,
    ineligibleAfterCancellation: 0,
    fillsUncertain: 0,
    positionOverruns: 0,
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
    this.exchange = new PaperExchange(this.cfg.execution, this.scheduler, (ev) => this.onExecutionEvent(ev), () => this.latestBook, {
      maxTradeLagMs: this.cfg.maxStalenessMs,
    });

    const h = this.fixture.header;
    this.validator = new StreamValidator(h);
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

    // The stream is consumed lazily in file order: each event is validated and logged when it is
    // encountered, so a bad event later in the file cannot leave a trace earlier in the ledger.
    this.pullNextEvent();

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

  /** Pull events from the fixture in file order until one can be scheduled at a future obsTime. */
  private pullNextEvent(): void {
    const events = this.fixture.events;
    while (this.fileIndex < events.length) {
      const ev = events[this.fileIndex++]!;
      if (ev.obsTime < this.start) {
        this.consumedEvents++;
        this.rejectObservation(ev, rejectObservation('outside_replay_range', `obsTime ${ev.obsTime} precedes replay start ${this.start}`));
        continue;
      }
      const order = this.validator.checkOrder(ev);
      if (!order.ok) {
        this.consumedEvents++;
        this.rejectObservation(ev, order);
        continue;
      }
      this.scheduler.schedule(ev.obsTime, Priority.MARKET, () => this.onMarketEvent(ev));
      return;
    }
  }

  private rejectObservation(ev: MarketEvent, r: Rejection): void {
    this.totals.observationsRejected++;
    this.win.rejectedObservations++;
    this.ledger.append({
      type: 'observation_rejected',
      simTime: this.now,
      eventId: ev.eventId,
      seq: ev.seq,
      obsTime: ev.obsTime,
      marketTime: ev.marketTime,
      reason: r.reason,
      detail: r.detail,
      phase: r.phase,
      encounteredAt: this.now,
    });
  }

  private onMarketEvent(ev: MarketEvent): void {
    this.consumedEvents++;
    try {
      const arrival = this.validator.checkArrival(ev);
      if (!arrival.ok) {
        this.rejectObservation(ev, arrival);
        return;
      }
      const stale = checkStaleness(ev, this.cfg.maxStalenessMs);
      if (!stale.ok) {
        this.rejectObservation(ev, stale);
        // A discarded print that was eligible for one of our orders is order-linked uncertainty, not silence.
        if (ev.type === 'trade') this.exchange.noteDiscardedTrade(ev, this.now);
        return;
      }
      this.acceptObservation(ev);
    } finally {
      this.pullNextEvent();
    }
  }

  private acceptObservation(ev: MarketEvent): void {
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
        this.bookHistory.push({ eventId: ev.eventId, obsTime: ev.obsTime, marketTime: ev.marketTime, mid });
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
          displayedAtLive: fmtQty(o.displayedAtLive),
          levelQueueAhead: fmtQty(o.levelQueueAtLive),
          betweenQueue: fmtQty(o.betweenQueueInitial),
          ownOrdersAhead: o.ownOrdersAheadAtLive,
          queueSource: 'level FIFO: level queue = displayed size when the first own order went live; between = level growth behind own orders ahead of us; both reduced only by eligible prints at this price',
          bookEventId: o.queueBookEventId,
          bookMarketTime: o.queueBookMarketTime,
          bookLagMs: o.queueBookMarketTime === null ? null : ev.at - o.queueBookMarketTime,
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
          finalAt: ev.finalAt,
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
          tradeMarketTime: ev.trade.marketTime,
          tradeObsTime: ev.trade.obsTime,
          outcome: ev.outcome,
          rule: 'eligible iff liveAt < trade.marketTime <= cancelEffectiveAt; a qualifying trade observed after the cancel took effect is a late fill',
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
          queueAheadAfter: fmtQty(ev.queueAheadAfter),
          note: 'print at our price absorbed by the displayed queue ahead of us in venue order; no fill awarded',
        });
        return;
      case 'fill':
        this.onFill(ev);
        return;
      case 'fill_reattributed':
        this.onReattribution(ev);
        return;
      case 'fill_ineligible':
        this.totals.fillsIneligible++;
        this.win.fillsIneligible++;
        if (ev.reason === 'predates_activation') this.totals.ineligiblePredatesActivation++;
        else if (ev.reason === 'at_activation_instant') this.totals.ineligibleAtActivationInstant++;
        else this.totals.ineligibleAfterCancellation++;
        this.ledger.append({
          type: 'fill_ineligible',
          simTime: this.now,
          orderId: o.orderId,
          tradeEventId: ev.trade.eventId,
          tradeMarketTime: ev.trade.marketTime,
          tradeObsTime: ev.trade.obsTime,
          orderLiveAt: o.liveAt,
          cancelEffectiveAt: o.cancelEffectiveAt,
          reason: ev.reason,
          note:
            ev.reason === 'at_activation_instant'
              ? 'print and activation share a venue millisecond; ordering unknown, no fill awarded'
              : ev.reason === 'predates_activation'
                ? 'print happened (marketTime) before the order rested on the book; observed afterwards'
                : 'print happened after the cancel took effect on the venue',
        });
        return;
      case 'fill_uncertain':
        this.totals.fillsUncertain++;
        this.ledger.append({
          type: 'fill_uncertain',
          simTime: this.now,
          orderId: o.orderId,
          tradeEventId: ev.trade.eventId,
          tradeMarketTime: ev.trade.marketTime,
          tradeObsTime: ev.trade.obsTime,
          orderLiveAt: o.liveAt,
          cancelEffectiveAt: o.cancelEffectiveAt,
          lagMs: ev.trade.obsTime - ev.trade.marketTime,
          reason: ev.reason,
          note: 'print was eligible on venue time but discarded as stale; the data cannot establish whether it filled us, nothing awarded',
        });
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
    const establishedByReordering = ev.establishedBy.eventId !== ev.sourceTrade.eventId;
    if (establishedByReordering) this.totals.establishedByReordering++;
    if (ev.afterCancelEffective) {
      this.totals.lateFillsAfterCancel++;
      this.win.lateFillsAfterCancel++;
    }
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
      sourceTradeEventId: ev.sourceTrade.eventId,
      sourceTradePrice: fmtPrice(ev.sourceTrade.price),
      sourceTradeSize: fmtQty(ev.sourceTrade.size),
      sourceMarketTime: ev.sourceTrade.marketTime,
      establishedByTradeEventId: ev.establishedBy.eventId,
      establishedByReordering,
      observedAt: this.now,
      fillType: ev.fillType,
      queueAheadBefore: fmtQty(ev.queueAheadBefore),
      duringCancelPending: ev.duringCancelPending,
      afterCancelEffective: ev.afterCancelEffective,
      realizedDelta: fmtMoney(app.realizedDelta),
      inventoryAfter: fmtQty(app.inventoryAfter),
      cashAfter: fmtMoney(app.cashAfter),
    });
    const portion: FillPortion = {
      portionId: `p${++this.portionSeq}`,
      fillId,
      orderId: o.orderId,
      side: o.side,
      price: o.price,
      qty: ev.qty,
      sourceTradeEventId: ev.sourceTrade.eventId,
      sourceMarketTime: ev.sourceTrade.marketTime,
      observedAt: this.now,
      measured: new Set(),
      pending: new Set(),
    };
    this.portions.push(portion);
    for (const h of this.cfg.outcomeHorizonsMs) this.scheduleOutcome(portion, h);
    const inventoryBefore = app.inventoryAfter - (o.side === 'buy' ? ev.qty : -ev.qty);
    if (absBig(app.inventoryAfter) > this.cfg.risk.maxPosition && absBig(app.inventoryAfter) > absBig(inventoryBefore)) {
      this.totals.positionOverruns++;
      this.ledger.append({
        type: 'risk_breach',
        simTime: this.now,
        kind: 'position_overrun',
        detail: `inventory ${fmtQty(app.inventoryAfter)} exceeds max position ${fmtQty(this.cfg.risk.maxPosition)} after ${ev.afterCancelEffective ? 'a late fill on a provisionally cancelled order' : 'a fill'}; the gate rejects any further increasing order`,
        netPnl: fmtMoney(this.portfolio.valuation(this.currentMark()).netPnl),
        limit: fmtQty(this.cfg.risk.maxPosition),
        action: 'no kill switch; increasing orders are rejected by the position limit until inventory is reduced',
      });
    }
    this.checkLossLimit();
  }

  /** The horizon runs on the source print's venue time; the outcome cannot become available before the portion was booked. */
  private scheduleOutcome(portion: FillPortion, horizonMs: number): void {
    const at = Math.max(this.now, portion.sourceMarketTime + horizonMs);
    this.pendingOutcomes++;
    portion.pending.add(horizonMs);
    if (at <= this.end) this.scheduler.schedule(at, Priority.OUTCOME, () => this.measureOutcome(portion, horizonMs));
  }

  /**
   * Already-booked quantity moves to its actual source print. Accounting is untouched. The affected
   * portion shrinks and a new portion carries the quantity with the new source and venue time; horizons
   * not yet measured on the old portion are re-run from the new source, measured ones are kept.
   */
  private onReattribution(ev: Extract<ExecutionEvent, { kind: 'fill_reattributed' }>): void {
    let remaining = ev.qty;
    const candidates = this.portions.filter((p) => p.orderId === ev.order.orderId && p.sourceTradeEventId === ev.fromTrade.eventId && p.qty > 0n).reverse();
    for (const from of candidates) {
      if (remaining <= 0n) break;
      const take = from.qty < remaining ? from.qty : remaining;
      from.qty -= take;
      remaining -= take;
      if (from.qty === 0n) {
        // Nothing is left to measure on the old source: its unmeasured horizons are no longer pending.
        this.pendingOutcomes -= from.pending.size;
        from.pending.clear();
      }
      const to: FillPortion = {
        portionId: `p${++this.portionSeq}`,
        fillId: from.fillId,
        orderId: from.orderId,
        side: from.side,
        price: from.price,
        qty: take,
        sourceTradeEventId: ev.toTrade.eventId,
        sourceMarketTime: ev.toTrade.marketTime,
        observedAt: this.now,
        measured: new Set(),
        pending: new Set(),
      };
      this.portions.push(to);
      const outcomesRebased: number[] = [];
      const outcomesKept: number[] = [];
      for (const h of this.cfg.outcomeHorizonsMs) {
        if (from.measured.has(h)) {
          to.measured.add(h);
          outcomesKept.push(h);
        } else {
          outcomesRebased.push(h);
          this.scheduleOutcome(to, h);
        }
      }
      this.totals.reattributed++;
      this.ledger.append({
        type: 'fill_reattributed',
        simTime: this.now,
        orderId: from.orderId,
        fillId: from.fillId,
        fromPortionId: from.portionId,
        toPortionId: to.portionId,
        qty: fmtQty(take),
        fromTradeEventId: ev.fromTrade.eventId,
        fromMarketTime: ev.fromTrade.marketTime,
        toTradeEventId: ev.toTrade.eventId,
        toMarketTime: ev.toTrade.marketTime,
        establishedByTradeEventId: ev.establishedBy.eventId,
        observedAt: this.now,
        outcomesRebased,
        outcomesKept,
        note: 'venue-order provenance of already-booked quantity moved to its actual source print; cash, inventory and fees unchanged',
      });
    }
    if (remaining !== 0n) throw new Error(`re-attribution of ${ev.qty} from ${ev.fromTrade.eventId} exceeds booked portions for ${ev.order.orderId}`);
  }

  /** Latest observed book whose venue time does not exceed `targetMarketTime`, else the latest observed book. */
  private bookAtVenueTime(targetMarketTime: number): { ref: BookRef; selection: 'venue_time' | 'latest_observed_fallback' } | null {
    let best: BookRef | null = null;
    for (const b of this.bookHistory) {
      if (b.marketTime <= targetMarketTime && (best === null || b.marketTime >= best.marketTime)) best = b;
    }
    if (best) return { ref: best, selection: 'venue_time' };
    const last = this.bookHistory[this.bookHistory.length - 1];
    return last ? { ref: last, selection: 'latest_observed_fallback' } : null;
  }

  private measureOutcome(fill: FillPortion, horizonMs: number): void {
    if (fill.pending.delete(horizonMs)) this.pendingOutcomes--;
    fill.measured.add(horizonMs);
    const chosen = fill.qty > 0n ? this.bookAtVenueTime(fill.sourceMarketTime + horizonMs) : null;
    const fillNotional = notional(fill.price, fill.qty);
    if (!chosen) {
      if (fill.qty > 0n) this.totals.outcomesUnmeasurable++;
      this.ledger.append({
        type: 'outcome',
        simTime: this.now,
        fillId: fill.fillId,
        portionId: fill.portionId,
        orderId: fill.orderId,
        side: fill.side,
        sourceTradeEventId: fill.sourceTradeEventId,
        sourceMarketTime: fill.sourceMarketTime,
        observedAt: fill.observedAt,
        horizonMs,
        availableAt: this.now,
        fillPrice: fmtPrice(fill.price),
        qty: fmtQty(fill.qty),
        midAtHorizon: null,
        midEventId: null,
        midMarketTime: null,
        midObsTime: null,
        midSelection: null,
        markout: null,
        markoutBps: null,
        status: fill.qty > 0n ? 'unmeasurable_no_book' : 'superseded_by_reattribution',
      });
      return;
    }
    const mid = chosen.ref.mid;
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
      portionId: fill.portionId,
      orderId: fill.orderId,
      side: fill.side,
      sourceTradeEventId: fill.sourceTradeEventId,
      sourceMarketTime: fill.sourceMarketTime,
      observedAt: fill.observedAt,
      horizonMs,
      availableAt: this.now,
      fillPrice: fmtPrice(fill.price),
      qty: fmtQty(fill.qty),
      midAtHorizon: fmtPrice(mid),
      midEventId: chosen.ref.eventId,
      midMarketTime: chosen.ref.marketTime,
      midObsTime: chosen.ref.obsTime,
      midSelection: chosen.selection,
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
      lateFillsAfterCancel: 0,
      fillsIneligible: 0,
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
        lateFillsAfterCancel: w.lateFillsAfterCancel,
        fillsIneligible: w.fillsIneligible,
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

    // The controller receives copies: the accepted instruction and the logged review are immutable records.
    const ctx: ControllerContext = {
      priorInstruction: structuredClone(prior),
      nextWindow,
      nextVersion: prior.version + 1,
      bounds: INSTRUCTION_BOUNDS,
      deadlineMs: this.cfg.controllerDeadlineMs,
    };
    const deadlineAt = nextWindow.start + this.cfg.controllerDeadlineMs;
    const wall0 = performance.now();
    let proposal;
    try {
      proposal = await this.controller.decide(structuredClone(review), ctx);
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
        establishedByReordering: t.establishedByReordering,
        reattributed: t.reattributed,
        lateAfterCancel: t.lateFillsAfterCancel,
        ineligible: t.fillsIneligible,
        ineligibleByReason: {
          predatesActivation: t.ineligiblePredatesActivation,
          atActivationInstant: t.ineligibleAtActivationInstant,
          afterCancellation: t.ineligibleAfterCancellation,
        },
        uncertain: t.fillsUncertain,
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
        positionOverruns: t.positionOverruns,
      },
      observations: {
        accepted: t.observationsAccepted,
        rejected: t.observationsRejected,
        notReached: this.fixture.events.length - this.consumedEvents,
      },
      windowRows: this.windowRows,
      assumptions: [...EXECUTION_ASSUMPTIONS],
      ledger: { entries: this.ledger.length, headHash: '' },
    };
  }
}

