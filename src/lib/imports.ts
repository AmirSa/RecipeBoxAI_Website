import { supabase } from './supabase';
import { escapeHtml } from './account';

// ─────────────────────────────────────────────────────────────────────────────
// Import tray — the web equivalent of the apps' processing bar.
//
// Imports run server-side (import-recipe Edge Function), so they survive the
// tab; this module makes them *visible* everywhere. Accepted imports are
// remembered in localStorage and a floating tray (mounted on every /my page
// via <ImportTray/>) tracks them:
//
//  - Tier 2 (when the web_import_jobs migration is applied): the tray reads
//    real statuses — live stage text while processing, honest error messages
//    on failure.
//  - Tier 1 fallback (table absent): polls the `recipes` table for the
//    pending ids and infers failure from a 15-minute timeout.
//
// The switch is automatic: the first jobs query that errors flips the tray to
// fallback mode for the session.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'rb-pending-imports';
const POLL_INTERVAL_MS = 4_000;
const STALE_AFTER_MS = 15 * 60_000; // fallback-mode failure inference
const DONE_TTL_MS = 24 * 60 * 60_000; // drop dismissed-but-forgotten entries after a day

export interface PendingImport {
  id: string;          // recipe id (row appears in `recipes` when finished)
  label: string;       // human label, e.g. "recipetineats.com" / "Photo scan"
  kind: 'text' | 'ai' | 'photo' | 'link';
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
    /* storage full/blocked — tray simply won't persist */
  }
}

/** Remember an accepted import so the tray can track it across pages/sessions. */
export function trackImport(entry: { id: string; label: string; kind: PendingImport['kind'] }) {
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
// Tray UI
// ─────────────────────────────────────────────────────────────────────────────

const ICON_SPINNER = '<span class="rb-imp-spin"></span>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M5 12l5 5L20 7"/></svg>';
const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="13" height="13"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';

const KIND_LABELS: Record<PendingImport['kind'], string> = {
  text: 'Text recipe',
  ai: 'AI recipe',
  photo: 'Photo scan',
  link: 'Link import',
};

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting…',
  extracting: 'Extracting the recipe…',
  nutrition: 'Analyzing nutrition…',
  saving: 'Saving to your library…',
};

let initialized = false;

/** Mount the tray on the current page (idempotent). */
export function initImportTray() {
  if (initialized || document.getElementById('rb-import-tray')) return;
  initialized = true;

  const tray = document.createElement('div');
  tray.id = 'rb-import-tray';
  document.body.appendChild(tray);

  function viewUrl(id: string) {
    return `/my/recipes/view/?id=${encodeURIComponent(id)}`;
  }

  function render() {
    const now = Date.now();
    // Garbage-collect ancient entries so the tray can't accumulate junk.
    const list = read().filter((e) => now - e.startedAt < DONE_TTL_MS);
    write(list);

    if (list.length === 0) {
      tray.innerHTML = '';
      tray.hidden = true;
      return;
    }
    tray.hidden = false;
    tray.innerHTML = list.map((e) => {
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
          <span class="rb-imp-text"><b>Import failed</b><small>${escapeHtml(e.error || `${label} didn't go through.`)}</small></span>
          <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
        </div>`;
      }
      if (e.status === 'stale') {
        return `<div class="rb-imp stale" data-id="${escapeHtml(e.id)}">
          <span class="rb-imp-ico warn">${ICON_WARN}</span>
          <span class="rb-imp-text"><b>Import didn't finish</b><small>${label} — it may not have contained a recipe.</small></span>
          <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
        </div>`;
      }
      const stageText = (e.stage && STAGE_LABELS[e.stage]) || 'safe to leave this page';
      return `<div class="rb-imp" data-id="${escapeHtml(e.id)}">
        <span class="rb-imp-ico">${ICON_SPINNER}</span>
        <span class="rb-imp-text"><b>Importing recipe…</b><small>${label} — ${escapeHtml(stageText)}</small></span>
        <button class="rb-imp-x" data-dismiss="${escapeHtml(e.id)}" aria-label="Dismiss">×</button>
      </div>`;
    }).join('');
  }

  tray.addEventListener('click', (ev) => {
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
        body: `${KIND_LABELS[e.kind] ?? 'Import'}${e.label ? ` · ${e.label}` : ''} finished importing.`,
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
      // it is also the ground truth that the row really landed.
      const unsettled = ids.filter((id) => jobs.get(id)?.status !== 'failed');
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
        if (found.has(e.id)) {
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

  render();
  poll();
}
