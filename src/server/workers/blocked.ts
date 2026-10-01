// An agent can sit at its prompt without being usable: stuck on a first-run screen, or not signed in
// on this machine (see ProviderAdapter.screen). Flag that as needing a human, and clear it once the
// screen moves on. An adapter that reads more off its screen (Cursor's approval prompt) does it itself.
import type { ProviderAdapter } from '../providers/types.js';
import { screenText } from './terminal.js';
import type { Worker, WorkerHandle } from './types.js';

export function checkBlocked(w: Worker, h: WorkerHandle<any>, screen: NonNullable<ProviderAdapter['screen']>) {
  if (!w.term || !(screen.blocked || screen.watch)) return;
  const s = w.info.status;
  if (!screen.watch && s !== 'starting' && s !== 'idle' && !(w.bootBlocked && s === 'needs_input')) return;
  // Only this run's output counts: a "Not logged in" in the scrollback from before is old news.
  const text = screenText(w.term, w.term.buffer.active.type === 'normal' ? Math.max(0, w.fresh?.line ?? 0) : 0);
  if (screen.watch) return screen.watch(h, text);
  const blocked = screen.blocked!(text, s === 'starting' || !!w.bootBlocked);
  if (blocked && s !== 'needs_input') {
    w.bootBlocked = true;
    w.info.activity = blocked;
    h.setStatus('needs_input');
  } else if (!blocked && w.bootBlocked && s === 'needs_input') {
    w.bootBlocked = false;
    w.info.activity = undefined;
    h.setStatus('idle');
  }
}
