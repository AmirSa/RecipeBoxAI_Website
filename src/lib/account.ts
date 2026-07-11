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

// ─────────────────────────────────────────────────────────────────────────────
// Profile lookup — resilient to the user_profiles UUID-case duplication.
//
// `user_profiles.user_id` is a TEXT column (not uuid), and iOS writes its row
// with an UPPERCASE UUID (Swift's `UUID` uppercases), which holds the real
// subscription state. The web/Android auth session's `user.id` is the canonical
// LOWERCASE UUID, so an exact `.eq('user_id', ...)` match can land on a stale
// duplicate row (e.g. a `free` shell) and miss the `pro` row entirely.
//
// We therefore match case-insensitively (`.ilike`, safe: a UUID has no `%`/`_`
// wildcard chars) and fold every row for this user into one logical profile:
// Pro wins over Free, and we take the most generous bonus-slot value. The
// `recipes`/`tags`/`cookbooks` tables use real `uuid` columns whose RLS
// normalizes case, so this quirk is confined to `user_profiles`.
// ─────────────────────────────────────────────────────────────────────────────

interface ProfileRow {
  subscription_tier: string | null;
  subscription_status: string | null;
  subscription_end_date: string | null;
  bonus_recipe_slots: number | null;
}

export interface ResolvedProfile {
  isPro: boolean;
  bonusSlots: number;
}

function rowIsPro(r: ProfileRow): boolean {
  if ((r.subscription_tier ?? '').toLowerCase() === 'pro') return true;
  if ((r.subscription_status ?? '').toLowerCase() === 'active') {
    const end = r.subscription_end_date ? Date.parse(r.subscription_end_date) : NaN;
    return isNaN(end) || end > Date.now();
  }
  return false;
}

export async function resolveProfile(userId: string): Promise<ResolvedProfile> {
  const { data } = await supabase
    .from('user_profiles')
    .select('subscription_tier, subscription_status, subscription_end_date, bonus_recipe_slots')
    .ilike('user_id', userId);
  const rows = (data ?? []) as ProfileRow[];
  return {
    isPro: rows.some(rowIsPro),
    bonusSlots: rows.reduce((m, r) => Math.max(m, r.bonus_recipe_slots ?? 0), 0),
  };
}

export async function getSaveGate(userId: string): Promise<SaveGate> {
  const [profile, countRes] = await Promise.all([
    resolveProfile(userId),
    supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null),
  ]);
  const tier = profile.isPro ? 'pro' : 'free';
  const limit = FREE_TIER_LIMIT + profile.bonusSlots;
  const used = countRes.count ?? 0;
  return { allowed: profile.isPro || used < limit, tier, used, limit };
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
  // Tier/bonus come from the (case-insensitively resolved) profile; the live
  // recipe count comes from RLS on the `recipes` uuid column, which is correct
  // regardless of the user_profiles duplication.
  const [profile, countRes] = await Promise.all([
    resolveProfile(userId),
    supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null),
  ]);
  return {
    email,
    tier: profile.isPro ? 'pro' : 'free',
    isPro: profile.isPro,
    recipeCount: countRes.count ?? 0,
    bonusSlots: profile.bonusSlots,
    limit: FREE_TIER_LIMIT + profile.bonusSlots,
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

/**
 * Set a recipe's favorite flag. This is the same "small mutation" the apps
 * perform (architecture doc §4.2): update the row and bump `updated_at`; both
 * apps adopt the server value on their next full sync, since a pulled row wins
 * over any non-pending local copy. RLS scopes the update to the signed-in user.
 */
export async function setRecipeFavorite(id: string, isFavorite: boolean): Promise<void> {
  const { error } = await supabase
    .from('recipes')
    .update({ is_favorite: isFavorite, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
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
  /** Best available cover: the cookbook's own image, else a member recipe's photo. */
  cover: string | null;
  count: number;
}

export async function fetchCookbooksWithCounts(): Promise<CookbookWithCount[]> {
  const [cbRes, linksRes] = await Promise.all([
    supabase
      .from('cookbooks')
      .select('id, name, description, image_url, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    supabase.from('cookbook_recipes').select('cookbook_id, recipe_id'),
  ]);
  // Surface a real failure instead of silently rendering "0 cookbooks" (which
  // is indistinguishable from a genuinely empty account and hides bugs).
  if (cbRes.error) throw new Error(cbRes.error.message);

  const links = (linksRes.data ?? []) as { cookbook_id: string; recipe_id: string }[];
  const counts = new Map<string, number>();
  for (const row of links) counts.set(row.cookbook_id, (counts.get(row.cookbook_id) ?? 0) + 1);

  // Cover fallback: like the apps' collage, use a member recipe's photo when
  // the cookbook has no image of its own.
  const imageByRecipe = new Map<string, string>();
  const recipeIds = [...new Set(links.map((l) => l.recipe_id))];
  if (recipeIds.length > 0) {
    const { data: imgRows } = await supabase
      .from('recipes')
      .select('id, image_url')
      .in('id', recipeIds)
      .is('deleted_at', null)
      .not('image_url', 'is', null);
    for (const r of (imgRows ?? []) as { id: string; image_url: string }[]) {
      imageByRecipe.set(r.id, r.image_url);
    }
  }
  const memberCover = new Map<string, string>();
  for (const l of links) {
    if (memberCover.has(l.cookbook_id)) continue;
    const img = imageByRecipe.get(l.recipe_id);
    if (img) memberCover.set(l.cookbook_id, img);
  }

  return ((cbRes.data ?? []) as Record<string, any>[]).map((c) => ({
    id: c.id,
    name: c.name || 'Untitled cookbook',
    description: c.description ?? null,
    image_url: c.image_url ?? null,
    cover: c.image_url ?? memberCover.get(c.id) ?? null,
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

/**
 * Create a cookbook — the webapp acting as a third sync client. Mirrors the
 * apps' create path (architecture doc §8): `upsert` a row with a client UUID,
 * `is_private = true` (the iOS-owned default), and ISO timestamps. We omit
 * `description` (Android-owned) and `image_url` so PostgREST partial upserts
 * leave those for the apps to fill, and never send `deleted_at`/`sync_status`.
 * `upsert` (not `insert`) keeps a retried create idempotent. RLS + the
 * `default auth.uid()` scope the row to the signed-in user.
 */
export async function createCookbook(name: string): Promise<CookbookWithCount> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('You must be signed in to create a cookbook.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('cookbooks')
    .upsert({ id, user_id: user.id, name, is_private: true, created_at: now, updated_at: now });
  if (error) throw new Error(error.message);
  return { id, name, description: null, image_url: null, cover: null, count: 0 };
}

/**
 * Hard-delete a cookbook. Membership links cascade server-side (FK ON DELETE
 * CASCADE) and an AFTER DELETE trigger writes a `deleted_cookbooks` tombstone,
 * so the apps drop it on their next full sync — exactly what the app's own
 * cookbook delete does. Deleting a cookbook never deletes its recipes. We do
 * NOT touch `deleted_cookbooks` or pre-delete `cookbook_recipes`.
 */
export async function deleteCookbook(id: string): Promise<void> {
  const { error } = await supabase.from('cookbooks').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/** Bump a cookbook's `updated_at` so other devices treat its membership as changed. */
async function touchCookbook(cookbookId: string): Promise<void> {
  await supabase
    .from('cookbooks')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', cookbookId);
}

/**
 * Add a recipe to a cookbook. Membership is `(cookbook_id, recipe_id)` with
 * `user_id` backfilled by the DB `default auth.uid()`. `upsert` is idempotent
 * on the PK, so re-adding an existing member is a no-op. We bump the parent
 * cookbook's `updated_at` to match the apps' "mark the cookbook pending".
 */
export async function addRecipeToCookbook(cookbookId: string, recipeId: string): Promise<void> {
  const { error } = await supabase
    .from('cookbook_recipes')
    .upsert({ cookbook_id: cookbookId, recipe_id: recipeId });
  if (error) throw new Error(error.message);
  await touchCookbook(cookbookId);
}

/** Remove a recipe from a cookbook (deletes the membership row; recipe is untouched). */
export async function removeRecipeFromCookbook(cookbookId: string, recipeId: string): Promise<void> {
  const { error } = await supabase
    .from('cookbook_recipes')
    .delete()
    .eq('cookbook_id', cookbookId)
    .eq('recipe_id', recipeId);
  if (error) throw new Error(error.message);
  await touchCookbook(cookbookId);
}

export interface RecipeBrief {
  id: string;
  title: string;
  image: string | null;
}

/**
 * Lightweight list of the user's recipes for the "add recipes" picker. Mirrors
 * the recipe query in `my/recipes/index.astro`, projecting only what the picker
 * needs. RLS scopes it to the signed-in user.
 */
export async function fetchRecipesBrief(): Promise<RecipeBrief[]> {
  const { data, error } = await supabase
    .from('recipes')
    .select('id, title, image_url')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, any>[]).map((r) => ({
    id: r.id,
    title: r.title || 'Untitled recipe',
    image: r.image_url ?? null,
  }));
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
