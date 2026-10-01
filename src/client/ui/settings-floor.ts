// The settings that belong to the floor you're on, not the building: its dog's name and how its
// workers' branches are named.
import type { Net } from '../net';
import { store } from '../state';
import { DOG_NAME_MAX, cleanDogName } from '../../shared/dog';
import { BRANCH_PLACEHOLDERS, BRANCH_TEMPLATE_MAX, DEFAULT_BRANCH_TEMPLATE, branchName, templateError } from '../../shared/branches';
import { h } from './dom';

/** Wraps a setting's controls with its name (see `setting` in settings.ts). */
type Setting = (title: string, scope: 'floor', ...body: Node[]) => HTMLElement;

/** The floor's settings sections, and what lets go of the store once ⚙️ Settings closes. */
export function floorSettings(net: Net, setting: Setting): { dog: HTMLElement; branches: HTMLElement; off(): void } {
  // The dog on this floor, named for everyone here.
  const dogInput = h('input', { type: 'text', maxlength: DOG_NAME_MAX, 'aria-label': 'The dog’s name', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const dogSave = h('button.btn.primary', { type: 'button' }, 'Rename');
  const dogNote = h('p.setting-note');
  const dogSection = setting('Office dog', 'floor', h('div.webhook', {}, dogInput, dogSave), dogNote);
  const paintDog = () => {
    const dog = store.dog;
    dogSection.classList.toggle('hidden', !dog);
    if (!dog) return;
    dogInput.placeholder = dog.name;
    dogNote.textContent = `${dog.name} lives on this floor. When a worker needs input, ${dog.name} runs to its desk and barks. Walk up and press E to pet it. A new name is for everyone on this floor.`;
  };
  paintDog();
  const renameDog = () => {
    const name = cleanDogName(dogInput.value);
    if (!name) return dogInput.focus();
    net.send({ t: 'dog.name', name });
    dogInput.value = '';
  };
  dogSave.addEventListener('click', renameDog);
  dogInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renameDog();
  });

  // How this floor names its workers' worktree branches.
  const branchInput = h('input', { type: 'text', maxlength: BRANCH_TEMPLATE_MAX, 'aria-label': 'Branch name template', placeholder: DEFAULT_BRANCH_TEMPLATE, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const branchSave = h('button.btn.primary', { type: 'button' }, 'Save');
  const branchReset = h('button.btn', { type: 'button' }, 'Use the default');
  const branchPreview = h('p.setting-note');
  const branchSection = setting(
    'Branch names',
    'floor',
    h('div.webhook', {}, branchInput, branchSave),
    h('div.seg', { style: 'margin-top:8px' }, branchReset),
    branchPreview,
    h('p.setting-note', {}, `When a worker gets its own worktree, its branch is named like this. Placeholders: ${BRANCH_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}. {slug} is the task's first words; {issue} drops out when there's no issue. A name that's taken gets -2. It's for everyone on this floor, and applies to the next worker hired.`),
  );
  let branchSaved: string | undefined;
  const previewBranch = () => {
    const t = branchInput.value.trim() || branchSaved || DEFAULT_BRANCH_TEMPLATE;
    const err = templateError(t);
    const user = store.me.account?.name ?? 'sam';
    branchPreview.classList.toggle('bad', !!err);
    branchPreview.textContent = err
      ? `⚠️ ${err}`
      : `e.g. ${branchName(t, { user, worker: 'Pixel', id: 'a1b2', issue: 42, task: 'Fix the login redirect' })}, or ${branchName(t, { user, worker: 'Pixel', id: 'a1b2', task: 'Add dark mode' })} without an issue`;
  };
  const paintBranch = () => {
    const floor = store.currentFloor();
    branchSection.classList.toggle('hidden', !floor);
    if (branchSaved !== floor?.branchTemplate) {
      branchSaved = floor?.branchTemplate;
      branchInput.value = branchSaved ?? '';
    }
    branchReset.classList.toggle('hidden', !branchSaved);
    previewBranch();
  };
  paintBranch();
  const saveBranch = () => {
    const t = branchInput.value.trim();
    if (templateError(t)) return branchInput.focus();
    net.send({ t: 'floor.branchTemplate', template: t });
  };
  branchInput.addEventListener('input', previewBranch);
  branchSave.addEventListener('click', saveBranch);
  branchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBranch();
  });
  branchReset.addEventListener('click', () => net.send({ t: 'floor.branchTemplate', template: '' }));

  const offs = [store.on('dog', paintDog), store.on('floors', paintBranch)];
  return { dog: dogSection, branches: branchSection, off: () => offs.forEach((off) => off()) };
}
