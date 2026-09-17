# The two clocks and the steering-instruction contract

Implementation: `src/engine/replay.ts` (timing), `src/controller/instruction.ts` (contract), `src/controller/types.ts` (interfaces), `src/controller/deterministic.ts`, `src/controller/llm.ts`.

## Timing

```
window k           |----------- 3000 ms -----------|  window k+1
policy ticks       t0   +300  +600 ... +2700         t0+3000 ...
                                                     ^
controller         reviews window k here, at the boundary T = start(k+1)
instruction        readyAt = T + modeled latency; must be <= T + controllerDeadlineMs (default 200 ms)
                   effectiveFrom = T; applies to every tick with time >= max(effectiveFrom, readyAt)
```

At one simulated millisecond the order is fixed by the scheduler: market observations, then order-state transitions, then outcome measurements, then the controller boundary, then the policy tick. So the controller's review of window `k` includes every observation with `obsTime <= T`, and its instruction can be used by the very first tick of window `k+1` when the modeled latency is zero. With latency `L > 0` the first `ceil(L / tick)` ticks of the next window still run on the prior instruction; the window summary lists every version used (`instructionVersionsUsed`).

The controller is invoked exactly once per completed window that has a successor and never from the tick path. Its wall-clock duration is measured for diagnostics but kept out of the ledger; only the **modeled** latency (`simulatedLatencyMs` on the proposal, or the controller's `modeledLatencyMs`) drives the deadline check.

## What the controller sees: `WindowReview`

Only information available at the boundary:

- window index and bounds; instruction versions used and the parameters in effect at the end
- market: book and trade counts, aggressor volumes, first/last/min/max mid, mid change in bps, average spread, last book age, rejected observations
- activity: ticks, decision mix, orders proposed/submitted/rejected (by risk, by venue), cancels, cancel/fill races, fills and fill quantities, partial fills, prints absorbed by the queue
- outcomes: per-horizon markout stats for outcomes **whose measurement horizon elapsed inside this window** (they may belong to earlier fills), the count of fills still pending, and cumulative stats
- portfolio valuation at the boundary (conservative mark) and risk state (limits, position utilisation, kill switch)

An outcome for a fill at time `f` with horizon `h` exists only from `f + h` onward. A fill at `T - 200 ms` with a 1 s horizon is `pending` in the review at `T` and `measured` in the review at `T + 3000`. This is tested.

## Instruction contract

```ts
{
  schemaVersion: 1,
  version: number,        // must equal prior accepted version + 1
  controllerId: string,
  basedOnWindow: number,  // must equal the reviewed window index
  issuedAt: number,
  effectiveFrom: number,  // must equal the next window's start
  params: {
    spreadMultiplierMilli:     500 ..4000   // x0.5 .. x4.0 on the policy's base half-spread
    sizeMultiplierMilli:         0 ..1500   // x0 .. x1.5 on the base quote size (0 = do not quote)
    maxInventoryFractionMilli:   0 ..1000   // share of the risk gate's max position the policy may use
    inventorySkewBps:            0 .. 100   // quote skew per unit of inventory utilisation
    quoteSides: 'both' | 'bid_only' | 'ask_only' | 'none'
  },
  reason: string          // <= 240 chars
}
```

Version 0 is the built-in safe default (x1.0, x1.0, full fraction, 20 bps skew, both sides) in force until the first accepted instruction.

## Acceptance

At the boundary the engine logs `controller_input`, calls the controller, logs `controller_output`, then applies exactly one of:

| outcome | when | effect |
|---|---|---|
| `instruction_accepted` | ready by the deadline and valid | becomes active from `max(effectiveFrom, readyAt)` |
| `instruction_rejected(late)` | `readyAt > T + controllerDeadlineMs` | prior instruction stays |
| `instruction_rejected(controller_failed)` | `decide` threw | prior instruction stays |
| `instruction_rejected(invalid)` | any contract violation (bounds, wrong version, wrong effective time, wrong window, unknown params, non-integers, bad latency) | prior instruction stays; the next expected version is unchanged |

The engine never clamps: an out-of-bounds proposal is rejected whole. Controllers that want to stay in bounds can use `clampParams` themselves.

## Deterministic controller (Milestone 1)

Rules in priority order, integer arithmetic, always clamped to the bounds:

1. kill switch active: `quoteSides = none`, size x0
2. fills this window with negative shortest-horizon markout: spread x1.5, size x0.75, skew +15 bps
3. no fills this window: spread x0.9 back toward x1.0, size +0.1 toward x1.0, skew -5 toward 20
4. otherwise hold
5. inventory utilisation above 60 %: quote only the reducing side, skew at least 50 bps

The point is not that these rules are good; it is that they produce a verifiable change in the next window's behaviour (the `steered` vs `unsteered` comparison, and the "steering demonstrably changes the next window" test).

## Future LLM controller

`LlmSteeringController` implements `SteeringController` against an injected `LlmClient` interface (`complete(request) -> Promise<string>`). It renders the review into a prompt, parses one JSON object with `params` and `reason`, stamps the versioning fields from the engine context, and returns the candidate with its modeled latency. No client implementation that reaches a network exists in this repository. Because the engine only calls controllers at window boundaries and only trusts modeled latency, a slow or misbehaving model shows up as `instruction_rejected(late | invalid | controller_failed)` rather than delaying the fast policy. `tests/llm-controller.test.ts` exercises all of these paths with a fake client.

Adding a real client later means: implement `LlmClient`, choose a modeled latency honestly (measure it), and keep the deadline. Nothing in the engine changes.
