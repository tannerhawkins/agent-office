import type { AgentProvider, ProjectInfo, Usage } from '../../shared/protocol';
import { h } from './dom';

const PROVIDER_KEY = 'agent-office.provider';

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  cursor: 'Cursor',
  custom: 'Custom',
};

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

function preferredProvider(options: AgentProvider[], fallback: AgentProvider): AgentProvider {
  try {
    const saved = localStorage.getItem(PROVIDER_KEY);
    if (saved && options.includes(saved as AgentProvider)) return saved as AgentProvider;
  } catch {
    // storage blocked
  }
  return options.includes(fallback) ? fallback : options[0];
}

export interface ProviderPicker {
  element: HTMLElement;
  value(): AgentProvider;
  /** The optional model override for the selected provider. Empty or invalid input is omitted. */
  model(): string | undefined;
  /** Reports a visible field error for an invalid nonempty model. */
  valid(): boolean;
}

const MODEL_MAX = 256;
/** Providers whose CLI takes a model; the server's agents.ts MODEL_FLAGS. */
const MODEL_PROVIDERS: AgentProvider[] = ['claude', 'opencode', 'codex', 'cursor'];
const MODEL_EXAMPLE: Partial<Record<AgentProvider, string>> = {
  claude: 'e.g. opus or sonnet',
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

/** A provider selector that never offers a provider outside the server's metadata. */
export function providerPicker(project: ProjectInfo | null, id: string, label = 'Worker provider'): ProviderPicker {
  const options = supportedProviders(project);
  const fallback = resolvedProvider(project?.defaultProvider, project);
  const select = h('select.provider-select', { id, 'aria-label': 'Worker provider' }) as HTMLSelectElement;
  for (const provider of options) select.append(h('option', { value: provider }, PROVIDER_LABEL[provider]));
  select.value = preferredProvider(options, fallback);
  const note = h('small.provider-note', {}, providerUsageNote(select.value as AgentProvider));
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
  const selected = () => select.value as AgentProvider;
  const setModelChoice = (provider: AgentProvider) => {
    const picks = MODEL_PROVIDERS.includes(provider);
    modelChoice.classList.toggle('hidden', !picks);
    modelInput.disabled = !picks;
    // A model belongs to one provider, so switching starts the choice over.
    modelInput.value = '';
    modelInput.setCustomValidity('');
    modelListEl.replaceChildren();
    if (!picks) return;
    const name = PROVIDER_LABEL[provider];
    modelLabel.textContent = `${name} model`;
    modelInput.placeholder = `Default (${name} settings)`;
    modelInput.setAttribute('aria-label', `${name} model`);
    const manual = `Optional; type a model id (${MODEL_EXAMPLE[provider]}).`;
    modelHint.textContent = modelLists.has(provider) ? manual : `Loading ${name} models… ${manual}`;
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
  setModelChoice(selected());
  select.addEventListener('change', () => {
    const provider = selected();
    note.textContent = providerUsageNote(provider);
    setModelChoice(provider);
    if (options.includes(provider)) {
      try {
        localStorage.setItem(PROVIDER_KEY, provider);
      } catch {
        // storage blocked
      }
    }
  });
  modelInput.addEventListener('input', () => modelInput.setCustomValidity(''));
  return {
    element: h('div.provider-choice', {}, h('label', { for: id }, label), select, note, modelChoice),
    value: () => (options.includes(selected()) ? selected() : fallback),
    model: () => {
      const value = modelInput.value.trim();
      return MODEL_PROVIDERS.includes(selected()) && validModel(selected(), value) ? value : undefined;
    },
    valid: () => {
      const value = modelInput.value.trim();
      if (!MODEL_PROVIDERS.includes(selected()) || !value) {
        modelInput.setCustomValidity('');
        return true;
      }
      const okay = validModel(selected(), value);
      const format = selected() === 'opencode' ? 'Use provider/model format without whitespace or control characters' : 'Use a model id without whitespace or control characters that does not start with "-"';
      modelInput.setCustomValidity(okay ? '' : `${format} (up to 256 characters).`);
      if (!okay) modelInput.reportValidity();
      return okay;
    },
  };
}
