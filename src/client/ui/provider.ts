import type { AgentChoice, AgentEffort, AgentProvider, ClaudeModel, ProjectInfo, Usage } from '../../shared/protocol';
import { AGENT_EFFORTS, CLAUDE_MODELS } from '../../shared/protocol';
import { store } from '../state';
import { h } from './dom';

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  cursor: 'Cursor',
  custom: 'Custom',
};

export const CLAUDE_MODEL_LABEL: Record<ClaudeModel, string> = {
  fable: 'Fable',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

export const EFFORT_LABEL: Record<AgentEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** A short badge for the task card / sidebar: "Opus", "Opus · High", or the raw model id. */
export function modelBadge(provider: AgentProvider | undefined, model: string | undefined, effort: AgentEffort | undefined): string | undefined {
  if (!model && !effort) return undefined;
  if (provider === 'claude') {
    const label = model && model in CLAUDE_MODEL_LABEL ? CLAUDE_MODEL_LABEL[model as ClaudeModel] : model;
    const parts = [label, effort ? EFFORT_LABEL[effort] : undefined].filter((v): v is string => !!v);
    return parts.length ? parts.join(' · ') : undefined;
  }
  return model;
}

/** Providers the server says this project can start. */
export function supportedProviders(project: ProjectInfo | null): AgentProvider[] {
  const values = project?.agentProviders?.filter((p): p is AgentProvider => p === 'claude' || p === 'opencode' || p === 'codex' || p === 'cursor' || p === 'custom') ?? [];
  if (values.length) return [...new Set(values)];
  return project?.defaultProvider && PROVIDER_LABEL[project.defaultProvider] ? [project.defaultProvider] : ['claude'];
}

/** Resolve old workers/tasks that have no provider metadata to the configured default. */
export function resolvedProvider(provider: AgentProvider | undefined, project: ProjectInfo | null): AgentProvider {
  // A worker/task keeps its identity even if the office was later restarted with a
  // configuration that no longer offers that provider.
  if (provider && PROVIDER_LABEL[provider]) return provider;
  const configured = project?.defaultProvider;
  return configured && PROVIDER_LABEL[configured] ? configured : supportedProviders(project)[0];
}

export function providerLabel(provider: AgentProvider | undefined, project: ProjectInfo | null): string {
  return PROVIDER_LABEL[resolvedProvider(provider, project)];
}

export function providerUsageTracked(provider: AgentProvider | undefined, project: ProjectInfo | null, usage?: Usage): boolean {
  const selected = resolvedProvider(provider, project);
  return selected === 'claude' || ((selected === 'opencode' || selected === 'codex' || selected === 'cursor' || selected === 'custom') && usage !== undefined);
}

export type ProviderUsageState = 'tracked' | 'waiting' | 'untracked';

/** Distinguishes a provider with no first report from one whose metrics are intentionally unavailable. */
export function providerUsageState(provider: AgentProvider | undefined, project: ProjectInfo | null, usage?: Usage): ProviderUsageState {
  const selected = resolvedProvider(provider, project);
  if (selected === 'claude') return usage ? 'tracked' : 'waiting';
  if (selected === 'opencode') return usage ? 'tracked' : 'waiting';
  if (selected === 'codex') return usage ? 'tracked' : 'waiting';
  if (selected === 'cursor') return usage ? 'tracked' : 'waiting';
  if (selected === 'custom') return usage ? 'tracked' : 'untracked';
  return 'untracked';
}

export function providerUsageNote(provider: AgentProvider): string {
  if (provider === 'claude') return 'Office usage and budget track Claude Code.';
  if (provider === 'codex') return 'Review Office hooks in /hooks to enable tracking. Codex reports root-session tokens; subagents are excluded and cost is unavailable.';
  if (provider === 'custom') return 'Usage is untracked unless compatible Claude Code hooks report it.';
  if (provider === 'cursor') return "Runs cursor-agent. Cursor reports each turn's tokens; the cost is an office estimate from list prices, not billing.";
  return 'OpenCode reports model/provider estimates; they are not billing, and arrive after the first report.';
}

/**
 * The worker a new one starts on unless someone picks another: the one set in ⚙️ Settings, or the
 * office's --agent on its own default model.
 */
export function officeChoice(project: ProjectInfo | null): AgentChoice {
  const picked = store.prompts.agent;
  if (picked && supportedProviders(project).includes(picked.provider)) {
    return { provider: picked.provider, ...(picked.model ? { model: picked.model } : {}), ...(picked.effort ? { effort: picked.effort } : {}) };
  }
  return { provider: resolvedProvider(project?.defaultProvider, project) };
}

/** "Claude Code · Opus · High", "Claude Code", "OpenCode · anthropic/claude-sonnet-4". */
export function choiceLabel(choice: AgentChoice): string {
  const badge = modelBadge(choice.provider, choice.model, choice.effort);
  return badge ? `${PROVIDER_LABEL[choice.provider]} · ${badge}` : PROVIDER_LABEL[choice.provider];
}

export interface ProviderPicker {
  element: HTMLElement;
  value(): AgentProvider;
  /** The optional model override for the selected provider: a Claude alias, or a model id the provider takes. */
  model(): string | undefined;
  /** The optional Claude reasoning effort. */
  effort(): AgentEffort | undefined;
  /** Reports a visible field error for an invalid nonempty model. */
  valid(): boolean;
}

export interface AgentFields extends ProviderPicker {
  /** Puts the fields on this provider, model and effort. */
  set(choice: AgentChoice): void;
  /** What they're on now. */
  choice(): AgentChoice;
}

const MODEL_MAX = 256;
/** Providers picked by typing a model id (Claude picks from its aliases instead); the server's agents.ts MODEL_FLAGS. */
const TYPED_MODEL_PROVIDERS: AgentProvider[] = ['opencode', 'codex', 'cursor'];
const MODEL_EXAMPLE: Partial<Record<AgentProvider, string>> = {
  opencode: 'provider/model',
  codex: 'e.g. gpt-5-codex',
  cursor: 'e.g. auto',
};
const modelLists = new Map<AgentProvider, { models: string[]; at: number }>();
const modelRequests = new Map<AgentProvider, Promise<string[]>>();

/** Mirrors the server's isValidModel: argv-safe ids, and OpenCode's are provider/model. */
function validModel(provider: AgentProvider, value: string): boolean {
  if (value.length === 0 || value.length > MODEL_MAX || /[\s\p{Cc}\p{Cf}]/u.test(value)) return false;
  if (provider !== 'opencode') return !value.startsWith('-');
  const parts = value.split('/');
  return parts.length >= 2 && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(parts[0]) && parts.slice(1).every((part) => part.length > 0);
}

function fetchModels(provider: AgentProvider): Promise<string[]> {
  const cached = modelLists.get(provider);
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.models);
  const pending = modelRequests.get(provider);
  if (pending) return pending;
  const request = fetch(`/api/agents/${provider}/models`, { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { models?: unknown };
      const models = Array.isArray(body.models) ? body.models.filter((m): m is string => typeof m === 'string' && validModel(provider, m)) : [];
      const list = [...new Set(models)];
      modelLists.set(provider, { models: list, at: Date.now() });
      return list;
    })
    .finally(() => {
      modelRequests.delete(provider);
    });
  modelRequests.set(provider, request);
  return request;
}

/**
 * The provider, model and effort fields: a provider selector that never offers a provider outside
 * the server's metadata, with a model (and, for Claude, reasoning effort) picker underneath.
 */
export function agentFields(project: ProjectInfo | null, id: string, initial: AgentChoice, label = 'Provider'): AgentFields {
  const options = supportedProviders(project);
  const fallback = resolvedProvider(project?.defaultProvider, project);
  const select = h('select.provider-select', { id, 'aria-label': 'Worker provider' }) as HTMLSelectElement;
  for (const provider of options) select.append(h('option', { value: provider }, PROVIDER_LABEL[provider]));
  const note = h('small.provider-note');
  const modelInput = h('input', {
    type: 'text',
    id: `${id}-model`,
    list: `${id}-models`,
    autocomplete: 'off',
    maxlength: MODEL_MAX,
  }) as HTMLInputElement;
  const modelHint = h('small.provider-model-hint');
  const modelListEl = h('datalist', { id: `${id}-models` });
  const modelLabel = h('label', { for: `${id}-model` });
  const modelChoice = h('div.provider-model', {}, modelLabel, modelInput, modelListEl, modelHint);

  const claudeModelSelect = h('select', { id: `${id}-claude-model`, 'aria-label': 'Claude model' }) as HTMLSelectElement;
  claudeModelSelect.append(h('option', { value: '' }, 'Default (--agent-args)'));
  for (const m of CLAUDE_MODELS) claudeModelSelect.append(h('option', { value: m }, CLAUDE_MODEL_LABEL[m]));
  const effortSelect = h('select', { id: `${id}-effort`, 'aria-label': 'Reasoning effort' }) as HTMLSelectElement;
  effortSelect.append(h('option', { value: '' }, 'Default'));
  for (const e of AGENT_EFFORTS) effortSelect.append(h('option', { value: e }, EFFORT_LABEL[e]));
  const claudeChoice = h(
    'div.provider-model.claude-model',
    {},
    h('label', { for: `${id}-claude-model` }, 'Model'),
    claudeModelSelect,
    h('label', { for: `${id}-effort` }, 'Effort'),
    effortSelect,
    h('small.provider-model-hint', {}, 'The cost panel tracks each model separately.'),
  );

  const element = h('div.provider-choice', {}, h('label', { for: id }, label), select, note, modelChoice, claudeChoice);
  const selected = () => select.value as AgentProvider;
  const typed = () => TYPED_MODEL_PROVIDERS.includes(selected());
  /** The selected provider's model suggestions, asked for only once someone can see the field. */
  const loadModels = () => {
    const provider = selected();
    if (!TYPED_MODEL_PROVIDERS.includes(provider) || !element.isConnected || element.closest('.hidden')) return;
    const manual = `Optional; type a model id (${MODEL_EXAMPLE[provider]}).`;
    modelHint.textContent = modelLists.has(provider) ? manual : `Loading ${PROVIDER_LABEL[provider]} models… ${manual}`;
    void fetchModels(provider)
      .then((models) => {
        if (selected() !== provider) return;
        modelListEl.replaceChildren(...models.map((model) => h('option', { value: model })));
        modelHint.textContent = models.length ? 'Optional; choose a suggestion or type a model id.' : manual;
      })
      .catch(() => {
        if (selected() === provider) modelHint.textContent = `Model suggestions unavailable. ${manual}`;
      });
  };
  const setModelVisibility = (provider: AgentProvider) => {
    const picks = TYPED_MODEL_PROVIDERS.includes(provider);
    note.textContent = providerUsageNote(provider);
    modelChoice.classList.toggle('hidden', !picks);
    modelInput.disabled = !picks;
    claudeChoice.classList.toggle('hidden', provider !== 'claude');
    if (picks) {
      const name = PROVIDER_LABEL[provider];
      modelLabel.textContent = `${name} model`;
      modelInput.placeholder = `Default (${name} settings)`;
      modelInput.setAttribute('aria-label', `${name} model`);
      modelHint.textContent = `Optional; type a model id (${MODEL_EXAMPLE[provider]}).`;
    }
    loadModels();
  };
  const set = (c: AgentChoice) => {
    select.value = options.includes(c.provider) ? c.provider : options.includes(fallback) ? fallback : options[0];
    const claude = select.value === 'claude';
    // A full Claude model id (set in ⚙️ Settings, say) gets an option of its own.
    if (claude && c.model && ![...claudeModelSelect.options].some((o) => o.value === c.model)) claudeModelSelect.append(h('option', { value: c.model }, c.model));
    claudeModelSelect.value = claude && c.model ? c.model : '';
    effortSelect.value = claude && c.effort ? c.effort : '';
    modelInput.value = TYPED_MODEL_PROVIDERS.includes(select.value as AgentProvider) && c.model ? c.model : '';
    modelInput.setCustomValidity('');
    modelListEl.replaceChildren();
    setModelVisibility(selected());
  };
  set(initial);
  select.addEventListener('change', () => {
    // A model belongs to one provider, so switching starts the choice over.
    modelInput.value = '';
    modelInput.setCustomValidity('');
    modelListEl.replaceChildren();
    setModelVisibility(selected());
  });
  modelInput.addEventListener('focus', loadModels);
  modelInput.addEventListener('input', () => modelInput.setCustomValidity(''));
  const value = () => (options.includes(selected()) ? selected() : fallback);
  const effort = () => (select.value === 'claude' && effortSelect.value ? (effortSelect.value as AgentEffort) : undefined);
  const model = () => {
    if (select.value === 'claude') return claudeModelSelect.value || undefined;
    if (!typed()) return undefined;
    const v = modelInput.value.trim();
    return validModel(selected(), v) ? v : undefined;
  };
  return {
    element,
    value,
    effort,
    model,
    set,
    choice: () => ({ provider: value(), ...(model() ? { model: model() } : {}), ...(effort() ? { effort: effort() } : {}) }),
    valid: () => {
      const v = modelInput.value.trim();
      if (!typed() || !v) {
        modelInput.setCustomValidity('');
        return true;
      }
      const okay = validModel(selected(), v);
      const format = selected() === 'opencode' ? 'Use provider/model format without whitespace or control characters' : 'Use a model id without whitespace or control characters that does not start with "-"';
      modelInput.setCustomValidity(okay ? '' : `${format} (up to 256 characters).`);
      if (!okay) modelInput.reportValidity();
      return okay;
    },
  };
}

/**
 * Which worker to start: the office's default (⚙️ Settings), shown as a line, with an ✏️ Edit button
 * that opens the provider, model and effort fields to pick another for this one.
 */
export function providerPicker(project: ProjectInfo | null, id: string, label = 'Worker'): ProviderPicker {
  let editing = false;
  const fields = agentFields(project, id, officeChoice(project));
  fields.element.classList.add('hidden');
  const current = h('span.provider-current');
  const edit = h('button.btn.small', { type: 'button', 'aria-expanded': 'false' }) as HTMLButtonElement;
  const element = h('div.provider-pick', {}, h('div.provider-summary', {}, h('span.provider-label', {}, label), current, edit), fields.element);
  const paint = () => {
    const def = officeChoice(project);
    current.textContent = choiceLabel(def);
    current.title = store.prompts.agent ? 'The office’s default worker, set in ⚙️ Settings' : 'The office’s default worker (its --agent); an admin can pick another in ⚙️ Settings';
    current.classList.toggle('hidden', editing);
    edit.textContent = editing ? '↺ Use the default' : '✏️ Edit';
    edit.title = editing ? `Back to ${choiceLabel(def)}` : 'Pick another provider, model or effort for this one';
    edit.setAttribute('aria-expanded', String(editing));
    fields.element.classList.toggle('hidden', !editing);
  };
  edit.addEventListener('click', () => {
    editing = !editing;
    paint();
    // They open on the default as it is now.
    if (!editing) return;
    fields.set(officeChoice(project));
    (fields.element.querySelector('select') as HTMLSelectElement | null)?.focus();
  });
  paint();
  // The default can change while this is open; it goes once its window has closed.
  const off = store.on('prompts', () => (element.isConnected ? paint() : off()));
  return {
    element,
    value: () => (editing ? fields.value() : officeChoice(project).provider),
    model: () => (editing ? fields.model() : officeChoice(project).model),
    effort: () => (editing ? fields.effort() : officeChoice(project).effort),
    valid: () => !editing || fields.valid(),
  };
}
