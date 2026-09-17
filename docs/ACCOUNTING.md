# Accounting

Implementation: `src/portfolio/accounting.ts`. Arithmetic: `src/core/money.ts`.

## Units

All values are `bigint` scaled by 10^6. Prices are quote-per-base, quantities are base units, money is quote units. No floating point is used in accounting, execution or risk. Decimal strings on the wire are parsed exactly and parsing refuses values with more than six places.

```
notional(price, qty) = round_half_up(price * qty / 1e6)          (money units)
fee(notional, bps)   = ceil(notional * bps / 10_000)              (rounded UP, against us)
```

## State

| symbol | meaning |
|---|---|
| `cash` | quote balance; starts at `initialCash`, moves on every fill, fee and transaction cost |
| `inventory` | signed base position |
| `positionCost` | signed cash outlay attributable to the currently open inventory (cost basis) |
| `grossRealized` | realized P&L before fees and costs |
| `feesPaid`, `txCostsPaid` | cumulative maker fees and fixed placement/cancel costs |

## Fill update

For a fill with side sign `s` (+1 buy, -1 sell), price `p`, quantity `q`, fee `f`, notional `N = notional(p, q)`:

```
cash        -= s * N + f
feesPaid    += f
```

If the fill extends the position (inventory is zero or has the same sign as `s`):

```
positionCost += s * N
```

Otherwise it closes `qc = min(q, |inventory|)` and opens `qo = q - qc`:

```
Nc           = notional(p, qc)  (or N when qc == q);  No = N - Nc
removedCost  = positionCost                     if qc == |inventory|
             = round_half_up(positionCost * qc / |inventory|) otherwise
realizedΔ    = -s * Nc - removedCost
grossRealized += realizedΔ
positionCost  = positionCost - removedCost + s * No
inventory    += s * q
```

Transaction costs: `cash -= amount; txCostsPaid += amount`.

## Valuation

Mark is **conservative**: long inventory is marked at the best bid, short at the best ask. If no book has ever been seen, inventory is valued at cost and `markPrice` is null. If the latest book is missing at valuation time, the last known book is used and `markMethod` says so.

```
inventoryValue = sign(inventory) * notional(mark, |inventory|)
unrealized     = inventoryValue - positionCost
equity         = cash + inventoryValue
netPnl         = equity - initialCash
```

## Reconciliation identity

Because `removedCost` appears with opposite signs in `realizedΔ` and in the remaining `positionCost`, rounding cancels exactly and this holds as an exact integer identity at every point in time:

```
netPnl == grossRealized + unrealized - feesPaid - txCostsPaid
```

`tests/accounting.test.ts` checks it after every fill of 50 random fill sequences, and `tests/engine.test.ts` rebuilds cash, inventory, fees, costs and realized P&L from ledger `fill` and `tx_cost` entries for three full replays and requires exact equality with the summary. `positionCost` is asserted to be zero whenever inventory is flat.

## What P&L here does and does not include

Included: maker fees, fixed placement and cancel costs, conservative marking. Not included: funding, borrow, slippage on any liquidation of the final inventory, taker fees (post-only orders never take), rebates, or any cost of capital. The final inventory is marked, not liquidated.
