import type { AgentId, AgentOption, WorkerInfo } from '../../shared/protocol';
import { store } from '../state';
import { h } from './dom';

// Which coding agent a new worker runs. Every hire dialog offers the office's agents; the last pick
// is remembered in this browser and is also what E hires with no dialog at all.

const KEY = 'agent-office.agent';

export function agentOptions(): AgentOption[] {
  return store.project?.agents ?? [];
}

export function agentOf(id: AgentId | undefined): AgentOption | undefined {
  return agentOptions().find((a) => a.id === (id ?? 'claude'));
}

/** The agent this person last picked, if the office still has it; else the office default. */
export function rememberedAgent(): AgentId | undefined {
  const usable = agentOptions().filter((a) => a.available);
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    // storage blocked
  }
  return usable.find((a) => a.id === saved)?.id ?? usable.find((a) => a.id === store.project?.defaultAgent)?.id ?? usable[0]?.id;
}

function remember(id: AgentId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage blocked
  }
}

/** A Claude / Cursor switch. Hidden when the office has only one agent to offer. */
export function agentPicker(): { el: HTMLElement; value(): AgentId | undefined } {
  const options = agentOptions();
  let chosen = rememberedAgent();
  const seg = h('div.seg.agent-pick', { role: 'radiogroup', 'aria-label': 'Agent' });
  const paint = () => {
    for (const b of seg.children) b.classList.toggle('on', (b as HTMLElement).dataset.agent === chosen);
  };
  for (const a of options) {
    seg.append(
      h(
        'button.btn',
        {
          type: 'button',
          role: 'radio',
          'data-agent': a.id,
          disabled: !a.available,
          title: a.available ? `Runs: ${a.cmd}` : `${a.cmd.split(' ')[0]} isn't installed on the office machine`,
          onclick: () => {
            chosen = a.id;
            remember(a.id);
            paint();
          },
        },
        agentBadge(a.id),
        a.label,
        a.available ? null : h('small', {}, 'not installed'),
      ),
    );
  }
  paint();
  const el = h('div.agent-row', {}, h('label', {}, 'Agent'), seg);
  if (options.length < 2) el.classList.add('hidden');
  return { el, value: () => chosen };
}

/** The little mark that tells a Cursor worker from a Claude one. */
export function agentBadge(id: AgentId | undefined): HTMLElement {
  const a = agentOf(id);
  return h('span.agent-badge', { style: `background:${a?.badgeColor ?? '#6c757d'}`, title: a?.label ?? '' }, a?.badge ?? '?');
}

/** A worker's agent badge, for agents only and only when the office runs more than one kind. */
export function workerBadge(w: WorkerInfo): HTMLElement | null {
  return w.kind === 'agent' && agentOptions().length > 1 ? agentBadge(w.agent) : null;
}

export function agentLabel(id: AgentId | undefined): string {
  return agentOf(id)?.label ?? 'agent';
}
