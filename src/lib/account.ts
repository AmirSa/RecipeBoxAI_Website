import { supabase } from './supabase';

export { supabase };

// ─────────────────────────────────────────────────────────────────────────────
// Wire-format decoding for the user `recipes` table.
// Contract (docs/SUPABASE_RECIPE_SYNC_ARCHITECTURE.md in the app repos):
//  - `ingredient_sections` and `detailed_nutrition` are JSON *strings* inside
//    the row (double-encoded), ingredient keys are camelCase.
//  - `instructions` is newline-joined plain text; legacy rows may still hold a
//    JSON array (of strings or {stepNumber, instruction} objects).
//  - Unknown keys must be ignored; a row with `deleted_at != null` is deleted.
// ─────────────────────────────────────────────────────────────────────────────

export interface WireIngredient {
  name: string;
  amount?: string | null;
  unit?: string | null;
  originalText?: string | null;
  additionalInfo?: string | null;
}

export interface WireIngredientSection {
  header?: string | null;
  ingredients: WireIngredient[];
}

export interface WireNutrition {
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
  fiber?: number | null;
  sugar?: number | null;
  sodium?: number | null;
  cholesterol?: number | null;
  saturated_fat?: number | null;
  potassium?: number | null;
  vitamin_a?: number | null;
  vitamin_c?: number | null;
  calcium?: number | null;
  iron?: number | null;
}

export interface UserRecipeRow {
  id: string;
  title: string | null;
  original_url: string | null;
  source_name: string | null;
  notes: string | null;
  prep_time: number;
  cook_time: number;
  total_time: number;
  servings: number;
  calories: number;
  is_favorite: boolean;
  rating: number;
  image_url: string | null;
  ingredient_sections: string | null;
  instructions: string | null;
  detailed_nutrition: string | null;
  created_at: string | null;
  updated_at: string | null;
  recipe_tags?: { tag_id: string }[];
}

export interface UserTagRow {
  id: string;
  name: string;
  color: string | null;
}

export function parseIngredientSections(raw: string | null | undefined): WireIngredientSection[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((s) => ({
      header: typeof s?.header === 'string' && s.header.trim() ? s.header.trim() : null,
      ingredients: Array.isArray(s?.ingredients)
        ? s.ingredients
            .map((i: Record<string, unknown>) => ({
              name: typeof i?.name === 'string' && i.name ? i.name : 'Unknown ingredient',
              amount: typeof i?.amount === 'string' ? i.amount : null,
              unit: typeof i?.unit === 'string' ? i.unit : null,
              originalText: typeof i?.originalText === 'string' ? i.originalText : null,
              additionalInfo: typeof i?.additionalInfo === 'string' ? i.additionalInfo : null,
            }))
        : [],
    }));
  } catch {
    return [];
  }
}

export function parseInstructions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr
          .map((s) => (typeof s === 'string' ? s : (s?.instruction ?? s?.text ?? '')))
          .map((s: string) => String(s).trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to newline splitting
    }
  }
  return trimmed.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function parseNutrition(raw: string | null | undefined): WireNutrition | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Tag colors are hex on the wire since 2026-07; older rows may still carry the
// original palette names until the owning device re-pushes them.
const LEGACY_TAG_COLORS: Record<string, string> = {
  red: '#e0533d',
  orange: '#e8853b',
  yellow: '#d9a514',
  green: '#3f8f4f',
  mint: '#3aa189',
  teal: '#2f8fa3',
  cyan: '#3193c6',
  blue: '#3d6fd8',
  indigo: '#5b5bd6',
  purple: '#8951c9',
  pink: '#d4549a',
  brown: '#96684a',
  gray: '#8e8e93',
  grey: '#8e8e93',
};

export function tagHex(color: string | null | undefined): string {
  if (!color) return LEGACY_TAG_COLORS.gray;
  const c = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c) || /^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7);
  return LEGACY_TAG_COLORS[c.toLowerCase()] ?? LEGACY_TAG_COLORS.gray;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitized same-site redirect target from a `?next=` param. */
export function safeNextPath(raw: string | null, fallback: string): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return fallback;
}

/**
 * Session for the current browser, or `null` after kicking off a redirect to
 * the login page (callers should stop rendering when they get `null`).
 */
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.replace(`/login/?next=${next}`);
    return null;
  }
  return session;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/login/';
}
