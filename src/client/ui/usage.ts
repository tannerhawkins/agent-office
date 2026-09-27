import type { Usage } from '../../shared/protocol';
import { store } from '../state';
import { $, h } from './dom';

export const tokensOf = (u: Usage) => u.input + u.output + u.cacheWrite + u.cacheRead;

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 10e6 ? 2 : 1)}M`;
}

export function fmtCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A cost, with "~" when part of it is a guess (Cursor reports tokens, not what they cost). */
export const fmtSpend = (u: Usage) => `${u.estimated ? '~' : ''}${fmtCost(u.cost)}`;

/** e.g. "$0.42 · 38k tokens" */
export const usageLabel = (u: Usage) => `${fmtSpend(u)} · ${fmtTokens(tokensOf(u))} tokens`;

/** The breakdown behind a figure, for a tooltip. */
export function usageTitle(u: Usage): string {
  return [
    `${fmtSpend(u)} over ${u.calls} API call${u.calls === 1 ? '' : 's'}`,
    `input ${fmtTokens(u.input)} · output ${fmtTokens(u.output)}`,
    `cache write ${fmtTokens(u.cacheWrite)} · cache read ${fmtTokens(u.cacheRead)}`,
    ...(u.estimated ? ["~ Cursor's share is estimated: it reports tokens but not their price"] : []),
  ].join('\n');
}

export function overBudget(): boolean {
  const s = store.usage;
  return s.budget !== undefined && s.today.cost >= s.budget;
}

/** New hires are refused: the daily budget is spent and the office runs with --budget-pause. */
export const hiringPaused = () => store.usage.pauseHiring && overBudget();

/** The sidebar's spend lines: what the workers at their desks cost, today's total and the budget. */
export function renderUsage() {
  const s = store.usage;
  let now = 0;
  let guessed = false;
  for (const w of store.workers.values()) {
    now += w.usage?.cost ?? 0;
    guessed ||= !!w.usage?.estimated;
  }
  const head = $('workers-cost');
  head.textContent = now > 0 ? `${guessed ? '~' : ''}${fmtCost(now)}` : '';
  head.title = 'Spent by the workers at their desks';

  const el = $('usage');
  const any = s.total.calls > 0 || s.budget !== undefined;
  el.classList.toggle('hidden', !any);
  if (!any) return;
  const over = overBudget();
  el.classList.toggle('over', over);
  const rows: HTMLElement[] = [
    h(
      'div.row',
      {},
      h('span', {}, '💸 Today'),
      h('b', { title: usageTitle(s.today) }, fmtSpend(s.today)),
      s.budget !== undefined ? h('span.muted', {}, `of ${fmtCost(s.budget)}`) : h('span.muted', {}, `· ${fmtTokens(tokensOf(s.today))} tokens`),
    ),
  ];
  if (s.budget !== undefined) {
    const pct = Math.min(100, (s.today.cost / s.budget) * 100);
    const state = over ? (s.pauseHiring ? 'Budget spent — no new hires until tomorrow' : 'Budget spent') : `${Math.round(pct)}% of today's budget`;
    rows.push(h('div.budget', { class: over ? 'over' : pct >= 80 ? 'near' : '', title: state, role: 'progressbar', 'aria-valuenow': Math.round(pct) }, h('div.fill', { style: `width:${pct}%` })));
  }
  rows.push(h('div.row.muted', { title: usageTitle(s.total) }, `All time ${fmtSpend(s.total)} · ${fmtTokens(tokensOf(s.total))} tokens`));
  el.replaceChildren(...rows);
}
