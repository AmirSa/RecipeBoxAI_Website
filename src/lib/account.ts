import { supabase, supabaseUrl } from './supabase';

export { supabase, supabaseUrl };

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
// Saving a shared (Discover) recipe into the user's library.
// Mirrors the Android app's SharedRecipeMappers.toRecipeEntity + push and the
// gate in SubscriptionRepository.canCreateRecipe: pro → unlimited, free →
// recipe_count < FREE_TIER_LIMIT + bonus_recipe_slots. After an insert the
// apps bump user_profiles.recipe_count and recipes_from_discover; so do we.
// ─────────────────────────────────────────────────────────────────────────────

export const FREE_TIER_LIMIT = 10;

export interface SharedSaveIngredient {
  name?: string | null;
  amount?: string | null;
  unit?: string | null;
  preparation?: string | null;
  additionalInfo?: string | null;
  originalText?: string | null;
}

export interface SharedSaveSection {
  name?: string | null;
  title?: string | null;
  ingredients?: SharedSaveIngredient[];
}

export interface SharedSaveData {
  slug: string;
  title: string;
  notes?: string | null;
  prep_time?: number;
  cook_time?: number;
  servings?: number;
  calories?: number;
  image_url?: string | null;
  sections?: SharedSaveSection[];
  instructions?: unknown[];
  nutrition?: Record<string, unknown> | null;
}

export interface SaveGate {
  allowed: boolean;
  tier: string;
  used: number;
  limit: number;
}

export async function getSaveGate(userId: string): Promise<SaveGate> {
  const [profileRes, countRes] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('subscription_tier, bonus_recipe_slots')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null),
  ]);
  const tier = profileRes.data?.subscription_tier ?? 'free';
  const limit = FREE_TIER_LIMIT + (profileRes.data?.bonus_recipe_slots ?? 0);
  const used = countRes.count ?? 0;
  return { allowed: tier === 'pro' || used < limit, tier, used, limit };
}

// Wire key → accepted source keys (shared recipes may carry either casing).
const WIRE_NUTRIENTS: [string, string[]][] = [
  ['protein', ['protein']],
  ['fat', ['fat']],
  ['carbs', ['carbs']],
  ['fiber', ['fiber']],
  ['sugar', ['sugar']],
  ['sodium', ['sodium']],
  ['cholesterol', ['cholesterol']],
  ['saturated_fat', ['saturated_fat', 'saturatedFat']],
  ['potassium', ['potassium']],
  ['vitamin_a', ['vitamin_a', 'vitaminA']],
  ['vitamin_c', ['vitamin_c', 'vitaminC']],
  ['calcium', ['calcium']],
  ['iron', ['iron']],
];

function wireNutritionString(nutrition: Record<string, unknown> | null | undefined): string | null {
  if (!nutrition) return null;
  const out: Record<string, number> = {};
  for (const [wireKey, sourceKeys] of WIRE_NUTRIENTS) {
    for (const key of sourceKeys) {
      const v = nutrition[key];
      if (typeof v === 'number' && isFinite(v) && v > 0) {
        out[wireKey] = v;
        break;
      }
    }
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/**
 * Insert the shared recipe as a new row in the user's `recipes` table and
 * bump the profile counters. Returns the new recipe id. The mobile apps pull
 * it on their next full sync exactly like a row created by the other app.
 */
export async function saveSharedRecipeToLibrary(userId: string, shared: SharedSaveData): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const sections = (shared.sections ?? []).map((s) => ({
    header: s.name ?? s.title ?? '',
    ingredients: (s.ingredients ?? []).map((i) => ({
      name: i.name ?? '',
      amount: i.amount ?? '',
      unit: i.unit ?? '',
      originalText: i.preparation ?? i.additionalInfo ?? i.originalText ?? '',
    })),
  }));

  const instructions = (shared.instructions ?? [])
    .map((st) => (typeof st === 'string' ? st : ((st as Record<string, unknown>)?.instruction ?? (st as Record<string, unknown>)?.text ?? '')))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join('\n');

  const prep = shared.prep_time ?? 0;
  const cook = shared.cook_time ?? 0;

  const { error } = await supabase.from('recipes').insert({
    id,
    user_id: userId,
    title: shared.title,
    original_url: `discover://${shared.slug}`,
    source_name: 'Discover',
    notes: shared.notes || null,
    prep_time: prep,
    cook_time: cook,
    total_time: prep + cook,
    servings: shared.servings ?? 4,
    calories: shared.calories ?? 0,
    is_favorite: false,
    rating: 0,
    image_url: shared.image_url || null,
    ingredient_sections: sections.length > 0 ? JSON.stringify(sections) : null,
    instructions: instructions || null,
    detailed_nutrition: wireNutritionString(shared.nutrition),
    created_at: now,
    updated_at: now,
  });
  if (error) throw new Error(error.message);

  // Best-effort counter bump (mirrors the apps' incrementRecipeCount; the
  // apps reconcile recipe_count on sign-in so a miss here self-heals).
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('recipe_count, recipes_from_discover')
      .eq('user_id', userId)
      .maybeSingle();
    if (profile) {
      await supabase
        .from('user_profiles')
        .update({
          recipe_count: (profile.recipe_count ?? 0) + 1,
          recipes_from_discover: (profile.recipes_from_discover ?? 0) + 1,
        })
        .eq('user_id', userId);
    }
  } catch {
    // non-fatal
  }

  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Account overview, tags, cookbooks (for the /account/ page)
// ─────────────────────────────────────────────────────────────────────────────

// Canonical tag palette, identical to the apps (core/util/TagColors.kt) so a
// color picked on the web renders the same in the app. Order matches the apps.
export const TAG_PALETTE: { hex: string; name: string }[] = [
  { hex: '#8E8E93', name: 'Gray' },
  { hex: '#007AFF', name: 'Blue' },
  { hex: '#34C759', name: 'Green' },
  { hex: '#FF9500', name: 'Orange' },
  { hex: '#FF3B30', name: 'Red' },
  { hex: '#AF52DE', name: 'Purple' },
  { hex: '#FF2D55', name: 'Pink' },
  { hex: '#FFCC00', name: 'Yellow' },
  { hex: '#30B0C7', name: 'Teal' },
  { hex: '#5856D6', name: 'Indigo' },
  { hex: '#00C7BE', name: 'Mint' },
  { hex: '#32ADE6', name: 'Cyan' },
  { hex: '#A2845E', name: 'Brown' },
];

export interface AccountSummary {
  email: string;
  tier: string;          // 'free' | 'pro'
  isPro: boolean;
  recipeCount: number;   // live count of non-deleted recipes
  bonusSlots: number;
  limit: number;         // FREE_TIER_LIMIT + bonusSlots
}

export async function getAccountSummary(userId: string, email: string): Promise<AccountSummary> {
  const [profileRes, countRes] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('subscription_tier, bonus_recipe_slots')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null),
  ]);
  const tier = profileRes.data?.subscription_tier ?? 'free';
  const bonusSlots = profileRes.data?.bonus_recipe_slots ?? 0;
  return {
    email,
    tier,
    isPro: tier === 'pro',
    recipeCount: countRes.count ?? 0,
    bonusSlots,
    limit: FREE_TIER_LIMIT + bonusSlots,
  };
}

export interface TagWithCount extends UserTagRow {
  count: number;
}

export async function fetchTagsWithCounts(): Promise<TagWithCount[]> {
  const [tagsRes, linksRes] = await Promise.all([
    supabase.from('tags').select('id, name, color').is('deleted_at', null).order('name'),
    supabase.from('recipe_tags').select('tag_id'),
  ]);
  const counts = new Map<string, number>();
  for (const row of (linksRes.data ?? []) as { tag_id: string }[]) {
    counts.set(row.tag_id, (counts.get(row.tag_id) ?? 0) + 1);
  }
  return ((tagsRes.data ?? []) as UserTagRow[]).map((t) => ({ ...t, count: counts.get(t.id) ?? 0 }));
}

export async function renameTag(id: string, name: string): Promise<void> {
  const { error } = await supabase.from('tags').update({ name }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function recolorTag(id: string, hex: string): Promise<void> {
  const { error } = await supabase.from('tags').update({ color: hex }).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Hard-delete a tag. `recipe_tags` links cascade server-side and a DB trigger
 * writes a `deleted_tags` tombstone, so the apps drop it on their next full
 * sync — exactly what the app's own tag delete does.
 */
export async function deleteTag(id: string): Promise<void> {
  const { error } = await supabase.from('tags').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export interface CookbookWithCount {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  count: number;
}

export async function fetchCookbooksWithCounts(): Promise<CookbookWithCount[]> {
  const [cbRes, linksRes] = await Promise.all([
    supabase
      .from('cookbooks')
      .select('id, name, description, image_url, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.from('cookbook_recipes').select('cookbook_id'),
  ]);
  const counts = new Map<string, number>();
  for (const row of (linksRes.data ?? []) as { cookbook_id: string }[]) {
    counts.set(row.cookbook_id, (counts.get(row.cookbook_id) ?? 0) + 1);
  }
  return ((cbRes.data ?? []) as Record<string, any>[]).map((c) => ({
    id: c.id,
    name: c.name || 'Untitled cookbook',
    description: c.description ?? null,
    image_url: c.image_url ?? null,
    count: counts.get(c.id) ?? 0,
  }));
}

export interface CookbookDetail {
  id: string;
  name: string;
  description: string | null;
  recipes: {
    id: string;
    title: string;
    totalTime: number;
    calories: number;
    image: string | null;
  }[];
}

export async function fetchCookbook(id: string): Promise<CookbookDetail | null> {
  const { data: cb } = await supabase
    .from('cookbooks')
    .select('id, name, description')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!cb) return null;

  const { data: links } = await supabase
    .from('cookbook_recipes')
    .select('recipe_id')
    .eq('cookbook_id', id);
  const recipeIds = ((links ?? []) as { recipe_id: string }[]).map((l) => l.recipe_id);

  let recipes: CookbookDetail['recipes'] = [];
  if (recipeIds.length > 0) {
    const { data: rows } = await supabase
      .from('recipes')
      .select('id, title, prep_time, cook_time, total_time, calories, image_url')
      .in('id', recipeIds)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    recipes = ((rows ?? []) as Record<string, any>[]).map((r) => ({
      id: r.id,
      title: r.title || 'Untitled recipe',
      totalTime: r.total_time || (r.prep_time || 0) + (r.cook_time || 0),
      calories: r.calories || 0,
      image: r.image_url ?? null,
    }));
  }
  return { id: cb.id, name: cb.name || 'Untitled cookbook', description: cb.description ?? null, recipes };
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

/**
 * Sign out and go to `dest`.
 *
 * `supabase.auth.signOut()` (default global scope) can hang forever on a
 * navigator Web Lock — the token is never cleared and the promise never
 * resolves, so the user appears stuck logged in. We therefore:
 *   1. clear the persisted session synchronously (the source of truth), and
 *   2. hard-navigate, which tears down the page and releases every lock,
 * without ever awaiting the SDK call. A local-scope signOut is fired in the
 * background as a courtesy (revokes nothing server-side; a web logout only
 * needs to forget this browser's session).
 */
export function signOut(dest = '/login/') {
  try {
    supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  } catch {
    /* ignore */
  }
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  window.location.href = dest;
}
