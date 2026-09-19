/**
 * A per-request cap on real outbound (LTA / OneMap / Google / NEA) calls.
 *
 * `runWithCallBudget(max, fn)` opens a budget that every upstream request made
 * anywhere inside `fn` - however deep in the planner - spends from, using
 * AsyncLocalStorage so nothing has to be threaded through the call chain.
 * Only calls that actually leave the server are counted: a cache hit, or a
 * request that joins an identical in-flight one, never reaches
 * `spendUpstreamCall`. Once the budget is spent, further upstream calls throw
 * `CallBudgetExceeded` and the planner degrades the way it does for any other
 * upstream failure (routes without live load data) instead of hammering the
 * upstream APIs.
 *
 * Outside a budget (every ordinary request) `spendUpstreamCall` is a no-op.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export class CallBudgetExceeded extends Error {
  constructor(max) {
    super(`Upstream call budget of ${max} exhausted`);
    this.name = 'CallBudgetExceeded';
    this.kind = 'budget';
  }
}

/** Counts one real outbound request against the active budget, if any. */
export function spendUpstreamCall() {
  const budget = storage.getStore();
  if (!budget) return;
  if (budget.used >= budget.max) {
    budget.exhausted = true;
    throw new CallBudgetExceeded(budget.max);
  }
  budget.used += 1;
}

/**
 * Runs `fn` under a fresh budget of `max` upstream calls.
 * @returns {Promise<{ value: any, used: number, max: number, exhausted: boolean }>}
 */
export async function runWithCallBudget(max, fn) {
  const budget = { max, used: 0, exhausted: false };
  const value = await storage.run(budget, fn);
  return { value, used: budget.used, max: budget.max, exhausted: budget.exhausted };
}
