import { supabase } from './supabase';
import { escapeHtml } from './account';

// ─────────────────────────────────────────────────────────────────────────────
// Import bell — the web equivalent of the apps' processing bar.
//
// Imports run server-side (import-recipe Edge Function), so they survive the
// tab; this module makes them *visible* everywhere. Accepted imports are
// remembered in localStorage and a notification bell in the nav (mounted on
// every /my page via <ImportTray/>) tracks them: a badge + spinning ring while
// anything is processing, a dropdown panel with per-import status rows, and a
// bell shake when an import settles (done/failed).
//
//  - Tier 2 (when the web_import_jobs migration is applied): the panel reads
//    real statuses — live stage text while processing, honest error messages
//    on failure.
//  - Tier 1 fallback (table absent): polls the `recipes` table for the
//    pending ids and infers failure from a 15-minute timeout.
//
// The switch is automatic: the first jobs query that errors flips the poller
// to fallback mode for the session.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'rb-pending-imports';
const POLL_INTERVAL_MS = 4_000;
const STALE_AFTER_MS = 15 * 60_000; // fallback-mode failure inference
const DONE_TTL_MS = 24 * 60 * 60_000; // drop dismissed-but-forgotten entries after a day

export interface PendingImport {
  id: string;          // recipe id (row appears in `recipes` when finished)
  label: string;       // human label, e.g. "recipetineats.com" / "Photo scan"
  kind: 'text' | 'ai' | 'photo' | 'link' | 'transform';
  // Transforms only: 'replace' rewrites an EXISTING row, so "row exists in
  // `recipes`" is meaningless as a completion signal — those settle on the
  // web_import_jobs status instead.
  mode?: 'new' | 'replace';
  startedAt: number;
  status: 'processing' | 'done' | 'failed' | 'stale';
  stage?: string;      // Tier 2: live pipeline stage
  error?: string;      // Tier 2: failure reason
}

function read(): PendingImport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && e.id && e.startedAt) : [];
  } catch {
    return [];
  }
}

function write(list: PendingImport[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage full/blocked — bell simply won't persist */
  }
}

/** Remember an accepted import so the bell can track it across pages/sessions. */
export function trackImport(entry: { id: string; label: string; kind: PendingImport['kind']; mode?: PendingImport['mode'] }) {
  const list = read().filter((e) => e.id !== entry.id);
  list.push({ ...entry, startedAt: Date.now(), status: 'processing' });
  write(list);
  notifyTray();
}

/** Forget an import (completed-and-viewed, or dismissed). */
export function removeImport(id: string) {
  write(read().filter((e) => e.id !== id));
  notifyTray();
}

/** Ask once for notification permission — call from a user gesture (submit). */
export function requestImportNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* unsupported */
  }
}

// Same-tab refresh signal (the `storage` event only fires in OTHER tabs).
function notifyTray() {
  window.dispatchEvent(new CustomEvent('rb-imports-changed'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bell UI
// ─────────────────────────────────────────────────────────────────────────────

const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const ICON_SPINNER = '<span class="rb-imp-spin"></span>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="13" height="13"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';

const KIND_LABELS: Record<PendingImport['kind'], string> = {
  text: 'Text recipe',
  ai: 'AI recipe',
  photo: 'Photo scan',
  link: 'Link import',
  transform: 'AI Transform',
};

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting…',
  extracting: 'Extracting the recipe…',
  transforming: 'Transforming the recipe…',
  nutrition: 'Analyzing nutrition…',
  image: 'Creating a cover photo…',
  saving: 'Saving to your library…',
};

let initialized = false;

/** Mount the import bell on the current page (idempotent). */
export function initImportTray() {
  if (initialized || document.getElementById('rb-import-bell')) return;
  initialized = true;

  const wrap = document.createElement('div');
  wrap.id = 'rb-import-bell';
  wrap.innerHTML = `
    <button id="rb-bell-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Recipe imports">
      ${ICON_BELL}
      <span id="rb-bell-badge" hidden></span>
    </button>
    <div id="rb-import-panel" hidden>
      <div class="rb-panel-head">Recipe imports</div>
      <div id="rb-import-list"></div>
    </div>`;

  // The bell lives in the nav, next to the account avatar / theme toggle.
  // Pages without that slot get a floating fallback so imports stay visible.
  // It starts hidden and only reveals itself for signed-in users — the tray
  // is also mounted on public pages (landing, Discover), where visitors may
  // not have a session.
  wrap.hidden = true;
  const slot = document.querySelector('.rb-nav .nav-actions');
  if (slot) slot.insertBefore(wrap, slot.firstChild);
  else {
    wrap.classList.add('rb-floating');
    document.body.appendChild(wrap);
  }

  const btn = document.getElementById('rb-bell-btn')!;
  const badge = document.getElementById('rb-bell-badge')!;
  const panel = document.getElementById('rb-import-panel')!;
  const listEl = document.getElementById('rb-import-list')!;

  function viewUrl(id: string) {
    return `/my/recipes/view/?id=${encodeURIComponent(id)}`;
  }

  function closePanel() {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  // Shake the bell when an import settles (done/failed/stale) so a status
  // change is noticeable without the panel being open.
  let lastSettled = -1;

  function render() {
    const now = Date.now();
    // Garbage-collect ancient entries so the panel can't accumulate junk.
    const list = read().filter((e) => now - e.startedAt < DONE_TTL_MS);
    write(list);

    const processing = list.some((e) => e.status === 'processing');
    const attention = list.some((e) => e.status === 'failed' || e.status === 'stale');

    badge.textContent = String(list.length);
    badge.hidden = list.length === 0;
    badge.classList.toggle('warn', attention && !processing);
    btn.classList.toggle('busy', processing);
    btn.title = processing ? 'Importing a recipe…' : 'Recipe imports';

    const settled = list.filter((e) => e.status !== 'processing').length;
    if (lastSettled >= 0 && settled > lastSettled) {
      btn.classList.remove('rb-shake');
      void (btn as HTMLElement).offsetWidth; // restart the animation
      btn.classList.add('rb-shake');
    }
    lastSettled = settled;

    if (list.length === 0) {
      listEl.innerHTML = '<div class="rb-imp-empty">No recipe imports right now.<br>Finished and in-progress imports show up here.</div>';
      return;
    }
    listEl.innerHTML = [...list].reverse().map((e) => {
      const isTransform = e.kind === 'transform';
      const label = `${KIND_LABELS[e.kind] ?? 'Import'}${e.label ? ` · ${escapeHtml(e.label)}` : ''}`;
      if (e.status === 'done') {
        return `<div class="rb-imp done" data-id="${escapeHtml(e.id)}">
          <span class="rb-imp-ico ok">${ICON_CHECK}</span>
          <span class="rb-imp-text"><b>Recipe ready</b><small>${label}</small></span>
          <a class="rb-imp-btn" data-view="${escapeHtml(e.id)}" href="${viewUrl(e.id)}">View</a>
          <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
        </div>`;
      }
      if (e.status === 'failed') {
        return `<div class="rb-imp stale" data-id="${escapeHtml(e.id)}">
          <span class="rb-imp-ico warn">${ICON_WARN}</span>
          <span class="rb-imp-text"><b>${isTransform ? 'Transform failed' : 'Import failed'}</b><small>${escapeHtml(e.error || `${label} didn't go through.`)}</small></span>
          <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
        </div>`;
      }
      if (e.status === 'stale') {
        return `<div class="rb-imp stale" data-id="${escapeHtml(e.id)}">
          <span class="rb-imp-ico warn">${ICON_WARN}</span>
          <span class="rb-imp-text"><b>${isTransform ? "Transform didn't finish" : "Import didn't finish"}</b><small>${label}${isTransform ? '' : ' — it may not have contained a recipe.'}</small></span>
          <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
        </div>`;
      }
      const stageText = (e.stage && STAGE_LABELS[e.stage]) || 'safe to leave this page';
      return `<div class="rb-imp" data-id="${escapeHtml(e.id)}">
        <span class="rb-imp-ico">${ICON_SPINNER}</span>
        <span class="rb-imp-text"><b>${isTransform ? 'Transforming recipe…' : 'Importing recipe…'}</b><small>${label} — ${escapeHtml(stageText)}</small></span>
        <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
      </div>`;
    }).join('');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  panel.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const target = ev.target as HTMLElement;
    const dismiss = target.closest('[data-dismiss]') as HTMLElement | null;
    if (dismiss) {
      removeImport(dismiss.dataset.dismiss!);
      return;
    }
    const view = target.closest('[data-view]') as HTMLElement | null;
    if (view) removeImport(view.dataset.view!); // navigation proceeds via href
  });

  function fireNotification(e: PendingImport) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const n = new Notification('Your recipe is ready 🍳', {
        body: `${KIND_LABELS[e.kind] ?? 'Import'}${e.label ? ` · ${e.label}` : ''} finished ${e.kind === 'transform' ? 'transforming' : 'importing'}.`,
        tag: `rb-import-${e.id}`,
      });
      n.onclick = () => {
        window.focus();
        window.location.href = viewUrl(e.id);
      };
    } catch {
      /* notification blocked */
    }
  }

  // Tier 2 availability: null = unknown, false = table absent (fallback mode).
  let jobsAvailable: boolean | null = null;

  interface JobRow { recipe_id: string; status: string; stage: string | null; error: string | null }

  async function poll() {
    const pending = read().filter((e) => e.status === 'processing');
    if (pending.length > 0) {
      const ids = pending.map((e) => e.id);

      // Tier 2: real job statuses, when the table exists.
      const jobs = new Map<string, JobRow>();
      if (jobsAvailable !== false) {
        const { data, error } = await supabase
          .from('web_import_jobs')
          .select('recipe_id, status, stage, error')
          .in('recipe_id', ids);
        if (error) {
          jobsAvailable = false; // table not migrated yet → fallback mode
        } else {
          jobsAvailable = true;
          for (const r of (data ?? []) as JobRow[]) jobs.set(r.recipe_id, r);
        }
      }

      // `recipes` check for everything the jobs table didn't already settle —
      // it is also the ground truth that the row really landed. Replace-mode
      // transforms are excluded: their row exists the whole time, so only the
      // job status can say when they're finished.
      const byId = new Map(pending.map((e) => [e.id, e]));
      const rowExistenceMeansDone = (e: PendingImport | undefined) =>
        !(e?.kind === 'transform' && e.mode === 'replace');
      const unsettled = ids.filter(
        (id) => jobs.get(id)?.status !== 'failed' && rowExistenceMeansDone(byId.get(id)),
      );
      let found = new Set<string>();
      if (unsettled.length > 0) {
        const { data } = await supabase.from('recipes').select('id').in('id', unsettled);
        found = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
      }

      const now = Date.now();
      let changed = false;
      const next = read().map((e): PendingImport => {
        if (e.status !== 'processing') return e;
        const job = jobs.get(e.id);
        if (job?.status === 'failed') {
          changed = true;
          return { ...e, status: 'failed', error: job.error ?? undefined };
        }
        if (found.has(e.id) || (e.kind === 'transform' && job?.status === 'done')) {
          changed = true;
          fireNotification(e);
          return { ...e, status: 'done' };
        }
        if (job?.stage && job.stage !== e.stage) {
          changed = true;
          return { ...e, stage: job.stage };
        }
        // Fallback-mode failure inference only — with real statuses available,
        // trust the jobs table instead of a timer.
        if (!job && jobsAvailable === false && now - e.startedAt > STALE_AFTER_MS) {
          changed = true;
          return { ...e, status: 'stale' };
        }
        // Edge: jobs table exists but the job row vanished (pruned) and the
        // recipe never appeared — fall back to the timeout there too.
        if (jobsAvailable === true && !job && now - e.startedAt > STALE_AFTER_MS) {
          changed = true;
          return { ...e, status: 'stale' };
        }
        return e;
      });
      if (changed) {
        write(next);
        render();
      }
    }
    // Poll fast while anything is pending, lazily otherwise (a finished import
    // from another tab still needs to show up here).
    const delay = read().some((e) => e.status === 'processing') ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 5;
    setTimeout(poll, delay);
  }

  window.addEventListener('rb-imports-changed', render);
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) render();
  });

  // Reveal the bell and start polling only once a session is confirmed —
  // signed-out visitors on public pages never see it (and anon polls would
  // return nothing anyway).
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (!session) return;
    wrap.hidden = false;
    render();
    poll();
  });
}
