/**
 * Branch names for workers' worktrees. Each floor can set a template such as `feat/{issue}-{slug}`;
 * the office fills it in when it cuts a worker's branch. Shared so Settings can preview a name.
 */

/** What floors that never set one get: office/<worker>-<id>, as the office always named them. */
export const DEFAULT_BRANCH_TEMPLATE = 'office/{worker}-{id}';
export const BRANCH_TEMPLATE_MAX = 100;
export const BRANCH_PLACEHOLDERS = ['user', 'worker', 'id', 'issue', 'slug'] as const;
export type BranchPlaceholder = (typeof BRANCH_PLACEHOLDERS)[number];

/** A template needs one of these, so two workers' branches don't come out the same every time. */
const DISTINCT: BranchPlaceholder[] = ['slug', 'id', 'worker'];
const SLUG_MAX = 40;
const NAME_MAX = 200;

export interface BranchVars {
  /** Who hired the worker (or queued its task). */
  user?: string;
  worker: string;
  id: string;
  issue?: number;
  /** What the task is about: its title, or the prompt. */
  task?: string;
}

/** Lower-case words joined by dashes, cut at a word boundary: "Fix the login!" → "fix-the-login". */
export function slugify(text: string, max = SLUG_MAX): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max + 1);
  const dash = cut.lastIndexOf('-');
  return (dash > max / 2 ? cut.slice(0, dash) : slug.slice(0, max)).replace(/-+$/, '');
}

/** The first few words of a task's first line, as a slug. */
export function taskSlug(task: string | undefined): string {
  const line = (task ?? '').split('\n').find((l) => l.trim()) ?? '';
  return slugify(line.trim().split(/\s+/).slice(0, 6).join(' '));
}

/**
 * The issue a hand-hired worker was given from the issues board, whose prompt starts
 * `Work on GitHub issue #12: "Title"` (see issuePrompt in client/ui/boards.ts).
 */
export function issueFromPrompt(prompt: string | undefined): { issue: number; title: string } | undefined {
  const m = /^Work on GitHub issue #(\d+): "(.*)"/.exec(prompt ?? '');
  return m ? { issue: Number(m[1]), title: m[2] } : undefined;
}

/** Why git wouldn't take this as a branch name, or undefined when it would (see git check-ref-format). */
export function refError(name: string): string | undefined {
  if (!name) return 'it would be empty';
  if (name.length > NAME_MAX) return `it would be longer than ${NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'it has a space or one of ~ ^ : ? * [ \\';
  if (name.includes('..') || name.includes('@{') || name === '@') return 'it has ".." or "@{"';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'it has an empty part between slashes';
  if (name.startsWith('-')) return 'it starts with "-"';
  for (const part of name.split('/')) {
    if (part.startsWith('.') || part.endsWith('.lock')) return 'a part starts with "." or ends with ".lock"';
  }
  if (name.endsWith('.')) return 'it ends with "."';
  return undefined;
}

/** Fills in a template. Placeholders with nothing to say drop out, with the separator beside them. */
export function branchName(template: string | undefined, vars: BranchVars): string {
  const values: Record<BranchPlaceholder, string> = {
    user: slugify(vars.user?.replace(/\s*\(queue\)$/, '') ?? ''),
    worker: slugify(vars.worker),
    id: slugify(vars.id),
    issue: vars.issue && Number.isInteger(vars.issue) && vars.issue > 0 ? String(vars.issue) : '',
    slug: taskSlug(vars.task) || slugify(vars.worker),
  };
  const filled = (template?.trim() || DEFAULT_BRANCH_TEMPLATE).replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key as BranchPlaceholder] || EMPTY : all));
  return dropEmpty(filled);
}

/** Why a floor can't use this template, or undefined when it can. '' means the default. */
export function templateError(template: string): string | undefined {
  const t = template.trim();
  if (!t) return undefined;
  if (t.length > BRANCH_TEMPLATE_MAX) return `Keep it under ${BRANCH_TEMPLATE_MAX} characters`;
  const used = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const unknown = used.find((k) => !(BRANCH_PLACEHOLDERS as readonly string[]).includes(k));
  if (unknown !== undefined) return `{${unknown}} isn't a placeholder; use ${BRANCH_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`;
  if (/[{}]/.test(t.replace(/\{\w+\}/g, ''))) return 'A { or } is left over';
  if (!used.some((k) => DISTINCT.includes(k as BranchPlaceholder))) return 'Include {slug}, {id} or {worker}, so each worker gets its own branch';
  // Every placeholder filled, and every optional one empty: both have to be branch names git takes.
  for (const vars of [
    { user: 'sam', worker: 'ada', id: 'a1b2', issue: 12, task: 'fix the login' },
    { worker: 'ada', id: 'a1b2' },
  ]) {
    const err = refError(branchName(t, vars));
    if (err) return `Git wouldn't take that as a branch name: ${err}`;
  }
  return undefined;
}

/** Stands in for a placeholder with nothing to say, until dropEmpty takes it out. */
const EMPTY = '\0';

/**
 * Takes out empty placeholders and the separator beside each: "feat/{issue}-{slug}" with no issue
 * is feat/fix, not feat/-fix, and "{user}/{slug}" with no user is just the slug. What the template
 * itself spells out is left alone, so templateError still sees it.
 */
function dropEmpty(name: string): string {
  return name
    .replace(/[-_.]\0/g, '')
    .replace(/\0[-_.]/g, '')
    .replace(/(^|\/)\0\//g, '$1')
    .replace(/\/\0(?=\/|$)/g, '')
    .replace(/\0/g, '');
}
