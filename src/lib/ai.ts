import { supabase, supabaseUrl, supabaseAnonKey } from './supabase';

// ─────────────────────────────────────────────────────────────────────────────
// AI recipe pipeline — the webapp acting as a third client of the shared
// Supabase `openai-proxy` Edge Function, exactly like the iOS/Android apps.
//
// Fidelity contract (source of truth: the iOS app):
//  - Request shape mirrors OpenAIProxyService.ProxyRequest — the proxy body is
//    `{ request: { endpoint, method, body, contentType }, operation }` sent
//    with the user's session JWT.
//  - The chat body mirrors ChatRequest.encode for reasoning models
//    (gpt-5-mini): `max_completion_tokens` + `reasoning_effort`, NO
//    temperature, `response_format: json_object`.
//  - Prompts are copied VERBATIM from OpenAIService.swift so a recipe created
//    on the web is field-for-field what the apps would produce. Do not "improve"
//    the wording here without changing the apps too.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'gpt-5-mini';
const MAX_OUTPUT_TOKENS = 4000;
const REASONING_EFFORT = 'minimal';
const REQUEST_TIMEOUT_MS = 300_000; // 5 min, matches the apps' URLSession config

export class NotARecipeError extends Error {
  constructor() {
    super("We couldn't find a recipe in that text.");
    this.name = 'NotARecipeError';
  }
}

// ── Extraction result types (mirror OpenAIRecipeResponse & friends) ─────────

export interface ExtractedIngredient {
  name: string;
  amount: string;
  unit: string;
  additionalInfo: string | null;
}

export interface ExtractedSection {
  name: string;
  ingredients: ExtractedIngredient[];
}

export interface ExtractedInstruction {
  stepNumber: number;
  instruction: string;
}

export interface ExtractedTags {
  mealType: string | null;
  cuisine: string | null;
  diet: string | null;
}

export interface ExtractedRichNutrient {
  name: string;
  type: string; // vitamin | mineral | antioxidant | fiber | omega
  amount: string;
  description: string;
}

export interface ExtractedNutrition {
  protein: number;
  fat: number;
  carbs: number;
  richNutrients: ExtractedRichNutrient[];
}

export interface ExtractedRecipe {
  title: string;
  prepTime: number;
  cookTime: number;
  servings: number;
  calories: number;
  notes: string | null;
  sections: ExtractedSection[];
  instructions: ExtractedInstruction[];
  tags: ExtractedTags | null;
  autoTags: string[];
  nutrition: ExtractedNutrition | null;
}

export interface NutritionalAnalysis {
  prepTime: number;
  cookTime: number;
  calories: number;
  tags: ExtractedTags | null;
  autoTags: string[];
  nutrition: ExtractedNutrition | null;
}

// ── Prompts (verbatim from OpenAIService.swift) ──────────────────────────────

// createURLRecipeExtractionPrompt() — also the system prompt for text imports.
const URL_RECIPE_EXTRACTION_PROMPT = `Extract recipe from web page content. Return JSON only.

JSON structure:
{
  "title": "Recipe Name",
  "prepTime": 0,
  "cookTime": 0,
  "servings": 0,
  "calories": 0,
  "notes": "",
  "sections": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "Section Name",
      "ingredients": [
        {
          "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "name": "ingredient name",
          "amount": "1",
          "unit": "cup",
          "additionalInfo": "",
          "section": "Section Name"
        }
      ]
    }
  ],
  "instructions": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "stepNumber": 1,
      "instruction": "Step text"
    }
  ],
  "tags": {
    "mealType": "",
    "cuisine": "",
    "diet": ""
  },
  "autoTags": ["Tag1", "Tag2"]
}

Recipe extraction rules:
1. Find the main recipe in the page content
2. Extract title, ingredients, and instructions
3. Parse measurements exactly (350g → amount:"350", unit:"g")
4. Group ingredients by section headers (Main Ingredients, For sauce, etc.)
5. If no sections, use "Main Ingredients"
6. Generate valid UUIDs (8-4-4-4-12 format)
7. ALWAYS provide prepTime and cookTime values (in minutes):
   - Extract from page content if explicitly stated
   - If not stated, estimate based on ingredients and cooking methods
   - prepTime: ingredient prep and setup time
   - cookTime: actual cooking/baking/chilling time
   - Never use 0 unless recipe truly requires no prep or cooking
8. Estimate servings if not specified
9. ALWAYS provide calories per serving:
   - Extract from page content if specified
   - If not provided, calculate estimate based on ingredients using standard nutritional values
   - Consider cooking methods and portion sizes
   - Provide realistic estimate, never use 0 unless truly applicable

Tag classification rules:
10. For mealType, choose ONE from: Breakfast, Lunch, Dinner, Dessert, Snacks, Appetizer
11. For cuisine, choose ONE from: Italian, Mexican, Asian, Indian, Mediterranean, American, Other
12. For diet, choose ONE from: Vegetarian, Vegan, Gluten-Free, Dairy-Free, Low Carb, Keto, Paleo, Regular
13. Use "Other" for cuisine and "Regular" for diet if unsure

Auto-tag classification rules:
14. Choose exactly TWO tags from this list: [Easy, Healthy, Weeknight, Pasta, Quick, Dinner, Breakfast, Lunch, Desserts, Appetizers, Side Dishes, Drinks, Vegetarian, Vegan, Gluten-Free, Dairy-Free, Air Fryer, Instant Pot, Slow Cooker, BBQ & Grilling, Sheet Pan, Baking]
15. Prefer specific method/equipment tags (Sheet Pan, Slow Cooker) over generic (Easy)
16. Choose one meal/type tag and one method/characteristic tag when possible
17. Base on ingredients, cooking method, and recipe complexity
18. Never use tags outside the specified list

Error responses:
- No recipe found: "The page does not contain a recipe."

Focus on finding structured recipe content (ingredients lists, numbered steps, cooking times). Ignore ads, comments, or non-recipe content.`;

// createNutritionalAnalysisPrompt()
const NUTRITIONAL_ANALYSIS_PROMPT = `Analyze this recipe and provide accurate prep time, cook time, calories per serving, tag classification, AND detailed nutrition information. Return JSON only.

JSON structure (CALCULATE ACTUAL VALUES - do not use example numbers):
{
  "prepTime": [actual_prep_minutes],
  "cookTime": [actual_cook_minutes],
  "calories": [calculated_calories_per_serving],
  "tags": {
    "mealType": "",
    "cuisine": "",
    "diet": ""
  },
  "autoTags": ["", ""],
  "nutrition": {
    "protein": 12.5,
    "fat": 8.3,
    "carbs": 25.7,
    "richNutrients": [
      {
        "name": "Vitamin C",
        "type": "vitamin",
        "amount": "45% DV",
        "description": "Supports immune system"
      },
      {
        "name": "Iron",
        "type": "mineral",
        "amount": "12mg",
        "description": "Essential for blood health"
      }
    ]
  }
}

Analysis rules:
1. PREP TIME (in minutes):
   - Consider all ingredient preparation: chopping, mixing, marinating, etc.
   - Include setup time for equipment
   - Account for complexity of ingredient prep
   - Minimum 5 minutes unless truly no prep needed

2. COOK TIME (in minutes):
   - Active cooking/baking/simmering time only
   - Do not include prep time
   - Consider multiple cooking stages if applicable
   - Use 0 only for no-cook recipes

3. CALORIES PER SERVING (CRITICAL - CALCULATE ACTUAL VALUE):
   - Calculate based on each ingredient and its quantity
   - Use standard nutritional values for each ingredient
   - Account for cooking methods (added oils, reduction, etc.)
   - Provide realistic estimates based on actual ingredients

4. DETAILED NUTRITION (per serving):
   - protein: grams of protein
   - fat: grams of total fat
   - carbs: grams of total carbohydrates
   - richNutrients: 3-5 nutrients this recipe is particularly rich in

5. RICH NUTRIENTS:
   - Focus on vitamins, minerals, antioxidants, fiber, omega acids
   - Only include if recipe provides significant amounts (>15% DV for vitamins/minerals)
   - Types: MUST be exactly one of these: "vitamin", "mineral", "antioxidant", "fiber", "omega"
   - DO NOT use "protein", "carbohydrate", "macronutrient" or any other type names
   - Provide practical descriptions of health benefits
   - Examples: Vitamin A, Vitamin C, Iron, Calcium, Potassium, Fiber, Omega-3

6. TAG CLASSIFICATION:
   - For mealType, choose ONE from: Breakfast, Lunch, Dinner, Dessert, Snacks, Appetizer
   - For cuisine, choose ONE from: Italian, Mexican, Asian, Indian, Mediterranean, American, Other
   - For diet, choose ONE from: Vegetarian, Vegan, Gluten-Free, Dairy-Free, Low Carb, Keto, Paleo, Regular
   - Use "Other" for cuisine and "Regular" for diet if unsure
   - Base classification on ingredients and cooking style

5. AUTO-TAGS:
   - Choose exactly two strings from this list: [Easy, Healthy, Weeknight, Pasta, Quick, Dinner, Breakfast, Lunch, Desserts, Appetizers, Side Dishes, Drinks, Vegetarian, Vegan, Gluten-Free, Dairy-Free, Air Fryer, Instant Pot, Slow Cooker, BBQ & Grilling, Sheet Pan, Baking]
   - Prefer specificity (Sheet Pan, BBQ & Grilling) over generic (Easy) if both apply
   - Try to pick one method/gear tag + one meal/type/diet tag when possible
   - Never invent tags or return values outside the list
   - Always return exactly two items

Return only the JSON object with these five values.`;

// extractRecipeFromText()'s user prompt template.
function textImportUserPrompt(text: string): string {
  return `The following text was written or pasted by a user who wants to save it as a recipe. It may be a fully formatted recipe, a casual description, a list of ingredients with rough instructions, or notes from memory.

Extract a complete, well-structured recipe from the text. If quantities are missing or vague (e.g., "a pinch", "some"), keep them as written. If the steps are unordered, sequence them logically. If a title is missing, invent a short, accurate one based on the dish.

User text:
---
${text}
---`;
}

// ── Proxy transport ──────────────────────────────────────────────────────────

type ChatContent = string | { type: 'text'; text: string }[];

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

/**
 * One chat completion through the `openai-proxy` Edge Function, authenticated
 * with the browser session's JWT (same call the apps make). Returns the
 * assistant message content.
 */
async function chatCompletion(messages: ChatMessage[], operation: string): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Please sign in to use AI features.');

  const body = {
    model: MODEL,
    messages,
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' },
    reasoning_effort: REASONING_EFFORT,
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/openai-proxy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      request: { endpoint: 'chat/completions', method: 'POST', body, contentType: 'application/json' },
      operation,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (payload && typeof payload.error === 'string' && payload.error) ||
      (payload && payload.error && typeof payload.error.message === 'string' && payload.error.message) ||
      `AI request failed (${res.status})`;
    throw new Error(msg);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content) throw new Error('The AI returned an empty response.');
  return content;
}

/** Port of OpenAIService.extractJSONFromResponse: fenced block → braces span → raw. */
export function extractJsonFromResponse(text: string): string {
  const fencedJson = text.match(/```json([\s\S]*?)```/);
  if (fencedJson) return fencedJson[1].trim();
  const fenced = text.match(/```([\s\S]*?)```/);
  if (fenced) {
    const content = fenced[1].trim();
    if (content.startsWith('{') && content.endsWith('}')) return content;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

// ── Lenient decoding (mirrors the Swift models' forgiving decoders) ──────────

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

function asInt(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return isFinite(n) ? Math.round(n) : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return isFinite(n) ? n : fallback;
}

function decodeNutrition(raw: unknown): ExtractedNutrition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const n = raw as Record<string, unknown>;
  const rich = Array.isArray(n.richNutrients)
    ? (n.richNutrients as Record<string, unknown>[]).map((r) => ({
        name: asString(r?.name, 'Unknown'),
        type: asString(r?.type, 'mineral').toLowerCase(),
        amount: asString(r?.amount),
        description: asString(r?.description),
      }))
    : [];
  return {
    protein: asNumber(n.protein),
    fat: asNumber(n.fat),
    carbs: asNumber(n.carbs),
    richNutrients: rich,
  };
}

function decodeTags(raw: unknown): ExtractedTags | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  return {
    mealType: typeof t.mealType === 'string' && t.mealType.trim() ? t.mealType : null,
    cuisine: typeof t.cuisine === 'string' && t.cuisine.trim() ? t.cuisine : null,
    diet: typeof t.diet === 'string' && t.diet.trim() ? t.diet : null,
  };
}

function decodeExtractedRecipe(json: string): ExtractedRecipe {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Couldn't read the AI's recipe — please try again.");
  }
  if (!raw || typeof raw !== 'object') throw new Error("Couldn't read the AI's recipe — please try again.");

  const sections: ExtractedSection[] = Array.isArray(raw.sections)
    ? (raw.sections as Record<string, unknown>[]).map((s) => ({
        name: asString(s?.name, 'Ingredients') || 'Ingredients',
        ingredients: Array.isArray(s?.ingredients)
          ? (s.ingredients as Record<string, unknown>[]).map((i) => ({
              name: asString(i?.name),
              amount: asString(i?.amount),
              unit: asString(i?.unit),
              additionalInfo: typeof i?.additionalInfo === 'string' && i.additionalInfo ? i.additionalInfo : null,
            })).filter((i) => i.name)
          : [],
      }))
    : [];

  // withFixedStepNumbers(): renumber sequentially, preserving given order.
  const instructions: ExtractedInstruction[] = (Array.isArray(raw.instructions) ? raw.instructions : [])
    .map((st: unknown) => asString((st as Record<string, unknown>)?.instruction ?? st).trim())
    .filter(Boolean)
    .map((instruction: string, i: number) => ({ stepNumber: i + 1, instruction }));

  const title = asString(raw.title).trim();
  if (!title || (sections.length === 0 && instructions.length === 0)) throw new NotARecipeError();

  return {
    title,
    prepTime: asInt(raw.prepTime),
    cookTime: asInt(raw.cookTime),
    servings: asInt(raw.servings, 4) || 4,
    calories: asInt(raw.calories),
    notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null,
    sections,
    instructions,
    tags: decodeTags(raw.tags),
    autoTags: Array.isArray(raw.autoTags) ? (raw.autoTags as unknown[]).map((t) => asString(t)).filter(Boolean) : [],
    nutrition: decodeNutrition(raw.nutrition),
  };
}

const NOT_A_RECIPE_MARKERS = ['does not contain a recipe', 'no recipe found', 'not a recipe'];

// ── Flow 1 of 4: paste text ──────────────────────────────────────────────────

/** Mirror of OpenAIService.extractRecipeFromText (operation `text_recipe_extraction`). */
export async function extractRecipeFromText(text: string): Promise<ExtractedRecipe> {
  const content = await chatCompletion(
    [
      { role: 'system', content: URL_RECIPE_EXTRACTION_PROMPT },
      { role: 'user', content: textImportUserPrompt(text) },
    ],
    'text_recipe_extraction',
  );

  const lower = content.toLowerCase();
  if (NOT_A_RECIPE_MARKERS.some((m) => lower.includes(m))) throw new NotARecipeError();

  return decodeExtractedRecipe(extractJsonFromResponse(content));
}

// ── Stage 2: nutrition analysis (shared by every import flow) ────────────────

/** Port of OpenAIService.buildRecipeAnalysisText. */
function buildRecipeAnalysisText(recipe: ExtractedRecipe): string {
  let text = `Title: ${recipe.title}\nServings: ${recipe.servings}\n\nIngredients:\n`;
  for (const section of recipe.sections) {
    text += `${section.name}:\n`;
    for (const ing of section.ingredients) {
      text += `- ${ing.amount} ${ing.unit} ${ing.name}`;
      if (ing.additionalInfo) text += ` (${ing.additionalInfo})`;
      text += '\n';
    }
    text += '\n';
  }
  text += 'Instructions:\n';
  for (const st of recipe.instructions) text += `${st.stepNumber}. ${st.instruction}\n`;
  return text;
}

/** Mirror of OpenAIService.analyzeNutritionalInfo (operation `nutritional_analysis`). */
export async function analyzeNutrition(recipe: ExtractedRecipe): Promise<NutritionalAnalysis> {
  const content = await chatCompletion(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: NUTRITIONAL_ANALYSIS_PROMPT },
          { type: 'text', text: `Recipe to analyze:\n${buildRecipeAnalysisText(recipe)}` },
        ],
      },
    ],
    'nutritional_analysis',
  );

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(extractJsonFromResponse(content));
  } catch {
    throw new Error('Nutrition analysis returned invalid data.');
  }
  if (typeof raw?.error === 'string') throw new Error(raw.error);

  return {
    prepTime: asInt(raw.prepTime),
    cookTime: asInt(raw.cookTime),
    calories: asInt(raw.calories),
    tags: decodeTags(raw.tags),
    autoTags: Array.isArray(raw.autoTags) ? (raw.autoTags as unknown[]).map((t) => asString(t)).filter(Boolean) : [],
    nutrition: decodeNutrition(raw.nutrition),
  };
}

/**
 * Merge the Stage 2 analysis into the extracted recipe the way the apps'
 * BackgroundRecipeProcessingManager does: nutrition always adopts the analysis;
 * times/calories only fill gaps the extraction left at 0.
 */
export function mergeNutrition(recipe: ExtractedRecipe, analysis: NutritionalAnalysis): ExtractedRecipe {
  return {
    ...recipe,
    prepTime: recipe.prepTime || analysis.prepTime,
    cookTime: recipe.cookTime || analysis.cookTime,
    calories: recipe.calories || analysis.calories,
    tags: recipe.tags ?? analysis.tags,
    autoTags: recipe.autoTags.length > 0 ? recipe.autoTags : analysis.autoTags,
    nutrition: analysis.nutrition ?? recipe.nutrition,
  };
}

// ── Saving to the library (wire format per RecipeSyncCodec) ──────────────────

export type RecipeSourceColumn =
  | 'recipes_from_link'
  | 'recipes_from_scan'
  | 'recipes_from_manual'
  | 'recipes_from_discover'
  | 'recipes_from_ai'
  | 'recipes_from_upload';

export interface SaveOptions {
  /** Pre-generated recipe id (needed when a cover image is uploaded first). */
  id?: string;
  originalUrl?: string | null;
  sourceName?: string | null;
  imageUrl?: string | null;
  /** user_profiles per-source counter to bump (text import = manual, like iOS). */
  sourceColumn: RecipeSourceColumn;
}

/** iOS RecipeSyncCodec.originalText(for:): "amount unit name, info". */
function ingredientOriginalText(i: ExtractedIngredient): string {
  const base = [i.amount, i.unit, i.name].filter(Boolean).join(' ');
  return i.additionalInfo ? `${base}, ${i.additionalInfo}` : base;
}

/**
 * Insert an extracted recipe as a new `recipes` row in the cross-platform wire
 * format (docs/SUPABASE_RECIPE_SYNC_ARCHITECTURE.md): double-encoded
 * `ingredient_sections` (header null for the default section, camelCase keys),
 * newline-joined `instructions`, flat `detailed_nutrition` blob with the
 * iOS-only `rich_nutrients` extra key. The apps pull it on their next full
 * sync exactly like a row created by the other app. Returns the new id.
 */
export async function saveExtractedRecipe(userId: string, recipe: ExtractedRecipe, opts: SaveOptions): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const now = new Date().toISOString();

  const wireSections = recipe.sections.map((s) => ({
    // JSON.stringify drops `undefined`, matching JSONEncoder omitting nils.
    header: !s.name || s.name === 'Ingredients' ? undefined : s.name,
    ingredients: s.ingredients.map((i) => ({
      name: i.name,
      amount: i.amount || undefined,
      unit: i.unit || undefined,
      originalText: ingredientOriginalText(i),
      additionalInfo: i.additionalInfo ?? undefined,
    })),
  }));

  const wireInstructions = recipe.instructions
    .slice()
    .sort((a, b) => a.stepNumber - b.stepNumber)
    .map((s) => s.instruction)
    .join('\n');

  const wireNutrition = recipe.nutrition
    ? JSON.stringify({
        protein: recipe.nutrition.protein,
        fat: recipe.nutrition.fat,
        carbs: recipe.nutrition.carbs,
        rich_nutrients: recipe.nutrition.richNutrients.length > 0 ? recipe.nutrition.richNutrients : undefined,
      })
    : null;

  const { error } = await supabase.from('recipes').insert({
    id,
    user_id: userId,
    title: recipe.title,
    original_url: opts.originalUrl ?? null,
    source_name: opts.sourceName ?? null,
    notes: recipe.notes,
    prep_time: recipe.prepTime,
    cook_time: recipe.cookTime,
    total_time: recipe.prepTime + recipe.cookTime,
    servings: recipe.servings,
    calories: recipe.calories,
    is_favorite: false,
    rating: 0,
    image_url: opts.imageUrl ?? null,
    ingredient_sections: wireSections.length > 0 ? JSON.stringify(wireSections) : null,
    instructions: wireInstructions || null,
    detailed_nutrition: wireNutrition,
    created_at: now,
    updated_at: now,
  });
  if (error) throw new Error(error.message);

  // Best-effort counter bump, mirroring the apps' incrementRecipeCount — the
  // apps reconcile recipe_count on sign-in, so a miss here self-heals.
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select(`recipe_count, ${opts.sourceColumn}`)
      .eq('user_id', userId)
      .maybeSingle();
    if (profile) {
      const row = profile as Record<string, number | null>;
      await supabase
        .from('user_profiles')
        .update({
          recipe_count: (row.recipe_count ?? 0) + 1,
          [opts.sourceColumn]: (row[opts.sourceColumn] ?? 0) + 1,
        })
        .eq('user_id', userId);
    }
  } catch {
    // non-fatal
  }

  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow 2 of 4: Create with AI (prompts verbatim from OpenAIService.swift)
// ─────────────────────────────────────────────────────────────────────────────

// The shared JSON-structure block of the generation prompts.
const GENERATION_JSON_BLOCK = `Return ONLY valid JSON with this exact structure:
{
  "title": "Recipe Name",
  "prepTime": 0,
  "cookTime": 0,
  "servings": 0,
  "calories": 0,
  "notes": "Optional cooking tips or interesting facts about the dish",
  "sections": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "Section Name",
      "ingredients": [
        {
          "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "name": "ingredient name",
          "amount": "1",
          "unit": "cup",
          "additionalInfo": "",
          "section": "Section Name"
        }
      ]
    }
  ],
  "instructions": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "stepNumber": 1,
      "instruction": "Step text"
    }
  ],
  "tags": {
    "mealType": "",
    "cuisine": "",
    "diet": ""
  },
  "autoTags": ["Tag1", "Tag2"]
}

JSON requirements:
1. Generate valid UUIDs (8-4-4-4-12 format) for all id fields
2. Provide accurate prepTime and cookTime in minutes
3. Estimate realistic servings
4. Calculate approximate calories per serving
5. Group ingredients by section if applicable (e.g., "For the Sauce", "Main Ingredients")
6. Number instructions sequentially starting from 1
7. Parse measurements correctly (e.g., "2 cups flour" → amount:"2", unit:"cups", name:"flour")

Tag classification:
- mealType: ONE from [Breakfast, Lunch, Dinner, Dessert, Snacks, Appetizer]
- cuisine: ONE from [Italian, Mexican, Asian, Indian, Mediterranean, American, Other]
- diet: ONE from [Vegetarian, Vegan, Gluten-Free, Dairy-Free, Low Carb, Keto, Paleo, Regular]
- autoTags: Exactly TWO from [Easy, Healthy, Weeknight, Pasta, Quick, Dinner, Breakfast, Lunch, Desserts, Appetizers, Side Dishes, Drinks, Vegetarian, Vegan, Gluten-Free, Dairy-Free, Air Fryer, Instant Pot, Slow Cooker, BBQ & Grilling, Sheet Pan, Baking]

Return only the JSON object, no markdown formatting, no explanation text.`;

/** createIngredientsRecipePrompt() — "What to Cook?" mode. */
function ingredientsRecipePrompt(ingredients: string): string {
  return `Generate a recipe from the following ingredients: ${ingredients}

IMPORTANT ASSUMPTIONS:
- Assume the user has basic spices (salt, pepper, garlic powder, onion powder, paprika, cumin, oregano, basil, thyme, etc.)
- Assume the user has basic pantry items (salt, cooking oil, butter)
- You do NOT need to list these as optional ingredients unless they are a key component

Requirements:
- Create a delicious, practical recipe using the provided ingredients as the main components
- If additional ingredients would significantly enhance the recipe, add them to an "Optional Ingredients" section
- Keep it simple and easy to follow
- Use common cooking techniques
- Include clear, step-by-step instructions
- Make sure the recipe is realistic and achievable for a home cook

${GENERATION_JSON_BLOCK.replace(
  '"notes": "Optional cooking tips or interesting facts about the dish",',
  '"notes": "Optional cooking tips. Mention any optional ingredients and how they enhance the recipe.",',
).replace(
  `5. Group ingredients by section if applicable (e.g., "For the Sauce", "Main Ingredients")
6. Number instructions sequentially starting from 1
7. Parse measurements correctly`,
  `5. ALWAYS create at least TWO sections: "Main Ingredients" for user's ingredients, and "Optional Ingredients" for suggested additions
6. The "Optional Ingredients" section should contain items that would enhance the dish but are not essential
7. Do NOT include basic spices or salt in the optional ingredients unless they are specialty items (e.g., saffron, smoked paprika)
8. Number instructions sequentially starting from 1
9. Parse measurements correctly`,
)}`;
}

/** createAdventurousRecipePrompt() — "Feeling Adventurous" mode. */
function adventurousRecipePrompt(): string {
  const cuisines = ['Italian', 'Mexican', 'Thai', 'Japanese', 'Indian', 'Mediterranean', 'French', 'Korean', 'Vietnamese', 'Chinese', 'Spanish', 'Greek', 'Moroccan', 'Brazilian', 'Lebanese', 'Turkish', 'Caribbean', 'Ethiopian', 'Peruvian', 'Cajun'];
  const dishTypes = ['pasta', 'stir-fry', 'curry', 'soup', 'salad', 'rice bowl', 'sandwich', 'pizza', 'taco', 'noodle dish', 'grilled dish', 'baked dish', 'casserole', 'stew', 'breakfast dish', 'seafood', 'vegetarian specialty', 'slow-cooked meal'];
  const shuffled = <T,>(a: T[]) => a.slice().sort(() => Math.random() - 0.5);
  const randomCuisines = shuffled(cuisines).slice(0, 5).join(', ');
  const randomDishTypes = shuffled(dishTypes).slice(0, 4).join(', ');
  const timestamp = Date.now() / 1000;

  return `I'm feeling adventurous today! Surprise me with something COMPLETELY DIFFERENT from what you might have suggested before. 

IMPORTANT: Be creative and varied! Consider these ideas for inspiration (but feel free to go beyond them):
- Explore cuisines like: ${randomCuisines}
- Try dish types like: ${randomDishTypes}
- Think outside the box - avoid obvious choices
- Consider seasonal ingredients, comfort foods, street food favorites, or restaurant classics

Session ID: ${timestamp} (use this to ensure variety across requests)

Requirements:
- Choose a popular, well-loved recipe that's DIFFERENT and EXCITING
- Use ingredients that are commonly available in most grocery stores
- Make it moderately easy to prepare (suitable for home cooks)
- Include clear, step-by-step instructions
- MAXIMIZE VARIETY - avoid repeating common suggestions like Chicken Tikka Masala
- Pick something that will genuinely surprise and delight me!
- Consider breakfast, lunch, dinner, dessert, or snack options equally
- Mix up protein sources (chicken, beef, pork, seafood, vegetarian, etc.)

${GENERATION_JSON_BLOCK}`;
}

/** Mirror of OpenAIService.generateRecipeFromIngredients (op `ingredients_recipe_generation`). */
export async function generateRecipeFromIngredients(ingredients: string): Promise<ExtractedRecipe> {
  const content = await chatCompletion(
    [{ role: 'user', content: ingredientsRecipePrompt(ingredients) }],
    'ingredients_recipe_generation',
  );
  return decodeExtractedRecipe(extractJsonFromResponse(content));
}

/** Mirror of OpenAIService.generateAdventurousRecipe (op `adventurous_recipe_generation`). */
export async function generateAdventurousRecipe(): Promise<ExtractedRecipe> {
  const content = await chatCompletion(
    [{ role: 'user', content: adventurousRecipePrompt() }],
    'adventurous_recipe_generation',
  );
  return decodeExtractedRecipe(extractJsonFromResponse(content));
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow 3 of 4: photo scan (vision) + cover-image upload
// ─────────────────────────────────────────────────────────────────────────────

/** createRecipeExtractionPrompt() — the Stage 1 vision prompt, verbatim. */
const RECIPE_SCAN_PROMPT = `Extract recipe from cookbook page images. Return JSON only. Focus on speed - ingredients, instructions, and basic info only.

JSON structure:
{
  "title": "Recipe Name",
  "prepTime": 0,
  "cookTime": 0,
  "servings": 0,
  "calories": 0,
  "notes": "",
  "sections": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "name": "Section Name",
      "ingredients": [
        {
          "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
          "name": "ingredient name",
          "amount": "1",
          "unit": "cup",
          "additionalInfo": "",
          "section": "Section Name"
        }
      ]
    }
  ],
  "instructions": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "stepNumber": 1,
      "instruction": "Step text"
    }
  ]
}

Recipe extraction rules:
1. Transcribe measurements exactly (350g → amount:"350", unit:"g")
2. Detect ingredient sections by headings like "Main Ingredients", "For the sauce", "To serve", "Crispy onions"
3. Group ingredients under their section headings
4. If no sections, use "Main Ingredients"
5. Parse: "350g green lentils, chopped" → name:"green lentils", amount:"350", unit:"g", additionalInfo:"chopped"
6. Include all ingredients and cooking steps
7. Generate valid UUIDs (8-4-4-4-12 format)
8. Set prepTime, cookTime, calories to default values - these will be calculated separately for speed
9. Extract servings if mentioned, otherwise estimate reasonable portion count
10. Do NOT include tags or autoTags - tag classification will happen in Stage 2

Error responses:
- Unreadable: "The Recipe scanned is not clear."
- Not recipe: "This is not a recipe."`;

export class UnreadableImageError extends Error {
  constructor() {
    super("We couldn't read that photo clearly.");
    this.name = 'UnreadableImageError';
  }
}

/**
 * Mirror of OpenAIService.extractRecipe(from: images) — a multimodal chat
 * completion (op `recipe_extraction`) with the photos as data-URL image parts,
 * exactly how the iPhone sends them.
 */
export async function extractRecipeFromImages(imageDataUrls: string[]): Promise<ExtractedRecipe> {
  const parts: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] = [
    { type: 'text', text: RECIPE_SCAN_PROMPT },
    ...imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  const content = await chatCompletion(
    // The parts union widens beyond chatCompletion's text-only type; the wire
    // shape is identical to the app's vision requests.
    [{ role: 'user', content: parts as never }],
    'recipe_extraction',
  );

  const lower = content.toLowerCase();
  if (lower.includes('not clear') || lower.includes('unclear')) throw new UnreadableImageError();
  if (NOT_A_RECIPE_MARKERS.some((m) => lower.includes(m))) throw new NotARecipeError();

  return decodeExtractedRecipe(extractJsonFromResponse(content));
}

/**
 * Downscale + JPEG-compress a user photo in the browser (the app's
 * preprocessImages equivalent) and return a data URL for the vision call
 * plus the JPEG blob for the Storage upload.
 */
export async function prepareImage(file: File, maxDim = 1600): Promise<{ dataUrl: string; blob: Blob }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the image.'))), 'image/jpeg', 0.8),
  );
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });
  return { dataUrl, blob };
}

/**
 * Upload a cover image to the shared `recipe-images` bucket at the apps' path
 * convention `{userId}/{recipeId}/{uuid}.jpg` (RecipeSyncService) and return
 * the public URL for the row's `image_url`.
 */
export async function uploadCoverImage(userId: string, recipeId: string, blob: Blob): Promise<string> {
  const path = `${userId}/${recipeId}/${crypto.randomUUID().toLowerCase()}.jpg`;
  const { error } = await supabase.storage
    .from('recipe-images')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from('recipe-images').getPublicUrl(path).data.publicUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow 4 of 4: add from link (YouTube / social platforms)
// ─────────────────────────────────────────────────────────────────────────────

/** Generic authenticated POST to a Supabase Edge Function (JWT + apikey, like the apps). */
async function edgeFunction<T>(name: string, body: unknown, timeoutMs = 180_000): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Please sign in to import recipes.');
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: supabaseAnonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (payload && typeof payload.message === 'string' && payload.message) ||
      (payload && typeof payload.error === 'string' && payload.error) ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return payload as T;
}

// iOS ScrapingBeeService.socialMediaDomains, verbatim.
const SOCIAL_MEDIA_DOMAINS = [
  'instagram.com', 'www.instagram.com', 'instagr.am',
  'facebook.com', 'www.facebook.com', 'fb.com', 'fb.watch', 'm.facebook.com',
  'tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com',
  'pinterest.com', 'www.pinterest.com', 'pin.it',
  'x.com', 'twitter.com',
];

export type LinkKind = 'youtube' | 'social' | 'web';

export function classifyLink(urlString: string): LinkKind {
  if (extractYouTubeVideoId(urlString)) return 'youtube';
  const lower = urlString.toLowerCase();
  if (SOCIAL_MEDIA_DOMAINS.some((d) => lower.includes(d))) return 'social';
  return 'web';
}

export function extractYouTubeVideoId(urlString: string): string | null {
  const m = urlString.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
  );
  return m ? m[1] : null;
}

// ── YouTube: transcript → Gemini (mirror of GeminiService) ──────────────────

interface YouTubeTranscriptResponse {
  videoId: string;
  title: string;
  description: string;
  transcript: string;
  segments: { text: string; start: number; duration: number }[];
  language: string;
}

interface GeminiRecipeJson {
  recipeName: string;
  ingredients: { name: string; amount: string; unit: string }[];
  instructions: string[];
}

// GeminiService's structured-output schema, verbatim.
const GEMINI_RECIPE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    recipeName: { type: 'STRING', description: 'The name of the recipe extracted from the transcript.' },
    ingredients: {
      type: 'ARRAY',
      description: 'A list of ingredients with quantities separated into amount, unit, and name.',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: "The ingredient name (e.g., 'tomatoes', 'flour', 'lentils')" },
          amount: { type: 'STRING', description: "The quantity/number (e.g., '3', '2', '350'). Empty string if no amount." },
          unit: { type: 'STRING', description: "The unit of measurement (e.g., 'cups', 'g', 'tbsp'). Empty string if no unit." },
        },
        required: ['name', 'amount', 'unit'],
      },
    },
    instructions: {
      type: 'ARRAY',
      description: 'A step-by-step guide on how to prepare the recipe.',
      items: { type: 'STRING' },
    },
  },
  required: ['recipeName', 'ingredients', 'instructions'],
};

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-2.5-flash-lite'];

async function geminiGenerate(model: string, requestBody: unknown, operation: string): Promise<GeminiRecipeJson> {
  const response = await edgeFunction<Record<string, unknown>>('gemini-proxy', {
    request: { model, requestBody },
    operation,
  });
  const text = (response as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
    ?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string' || !text) throw new Error('Empty response from Gemini.');
  if (text.toLowerCase().includes('not a recipe')) throw new NotARecipeError();
  const parsed = JSON.parse(text) as GeminiRecipeJson;
  if (!parsed.recipeName || !parsed.ingredients?.length || !parsed.instructions?.length) throw new NotARecipeError();
  return parsed;
}

function geminiToExtractedRecipe(g: GeminiRecipeJson, videoTitle: string | null): ExtractedRecipe {
  // Deduplicate ingredients by normalized name (GeminiRecipeResponse.deduplicateIngredients).
  const seen = new Set<string>();
  const ingredients = g.ingredients
    .filter((i) => {
      const key = i.name.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((i) => ({ name: i.name, amount: i.amount ?? '', unit: i.unit ?? '', additionalInfo: null }));

  return {
    title: g.recipeName,
    prepTime: 0,
    cookTime: 0,
    servings: 4,
    calories: 0,
    notes: videoTitle ? `Recipe extracted from YouTube video: ${videoTitle}` : 'Recipe extracted from YouTube video',
    sections: [{ name: 'Ingredients', ingredients }],
    instructions: g.instructions.map((instruction, i) => ({ stepNumber: i + 1, instruction })),
    tags: null,
    autoTags: ['YouTube'],
    nutrition: null,
  };
}

/** Mirror of GeminiService.extractRecipeFromYouTube: transcript first, video-embedding fallback. */
async function extractRecipeFromYouTube(urlString: string, videoId: string): Promise<ExtractedRecipe> {
  // Transcript path.
  try {
    const t = await edgeFunction<YouTubeTranscriptResponse>('youtube-transcript-proxy', { videoId });
    if ((t.transcript ?? '').length > 100) {
      const requestBody = {
        contents: [{
          parts: [{
            text: `I have a transcript from a YouTube cooking video. Please analyze this transcript and extract the recipe information.

Video Title: ${t.title}

Video Description: ${(t.description ?? '').slice(0, 500)}

Transcript:
${t.transcript}

Please extract the following information:
1. Recipe name (use the video title if a specific recipe name isn't mentioned)
2. List of ingredients with quantities separated into amount, unit, and name
3. Step-by-step cooking instructions

For ingredients:
- Separate amount (number), unit (measurement), and name (ingredient)
- Example: "3 tomatoes" → amount:"3", unit:"", name:"tomatoes"
- Example: "2 cups flour" → amount:"2", unit:"cups", name:"flour"
- Example: "350g lentils" → amount:"350", unit:"g", name:"lentils"
- If no amount/unit, leave those fields empty

If this transcript does not contain a recipe, respond with an error indicating "not a recipe".`,
          }],
        }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_RECIPE_SCHEMA },
      };
      const g = await geminiGenerate(GEMINI_MODELS[0], requestBody, 'youtube_transcript');
      return geminiToExtractedRecipe(g, t.title);
    }
  } catch (err) {
    if (err instanceof NotARecipeError) throw err;
    // fall through to video-embedding path
  }

  // Video-embedding fallback across the model priority list.
  let lastError: Error | null = null;
  for (const model of GEMINI_MODELS) {
    try {
      const requestBody = {
        contents: [{
          parts: [
            {
              text: `Please analyze this YouTube video and extract the recipe information. The video URL is: https://www.youtube.com/watch?v=${videoId}

Extract the following information:
1. Recipe name
2. List of ingredients with quantities separated into amount, unit, and name
3. Step-by-step cooking instructions

For ingredients:
- Separate amount (number), unit (measurement), and name (ingredient)
- Example: "3 tomatoes" → amount:"3", unit:"", name:"tomatoes"
- Example: "2 cups flour" → amount:"2", unit:"cups", name:"flour"
- Example: "350g lentils" → amount:"350", unit:"g", name:"lentils"
- If no amount/unit, leave those fields empty

If this video does not contain a recipe, respond with an error indicating "not a recipe".`,
            },
            { fileData: { mimeType: 'video/youtube', fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_RECIPE_SCHEMA },
      };
      const g = await geminiGenerate(model, requestBody, 'youtube');
      return geminiToExtractedRecipe(g, null);
    } catch (err) {
      if (err instanceof NotARecipeError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("Couldn't extract a recipe from this video.");
}

// ── Social platforms: ScrapingBee → LLM (→ audio transcription fallback) ────

interface ScrapingBeeResponse {
  success: boolean;
  html: string;
  metadata: { platform: string; ogImage: string | null; ogTitle: string | null };
}

// Cap the scraped HTML sent to the model; social pages can be enormous.
const MAX_PAGE_CONTENT_CHARS = 300_000;

/** The LLM half of OpenAIService.extractRecipeFromURL (op `url_recipe_extraction`), with its retry loop. */
async function extractRecipeFromPageContent(urlString: string, html: string): Promise<ExtractedRecipe> {
  const maxRetries = 2;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const parts = [
      {
        type: 'text' as const,
        text: attempt === 0
          ? URL_RECIPE_EXTRACTION_PROMPT
          : 'Return valid JSON only—no text. Use the exact JSON structure from the previous prompt.',
      },
      { type: 'text' as const, text: `URL: ${urlString}\n\nPage Content:\n${html.slice(0, MAX_PAGE_CONTENT_CHARS)}` },
    ];
    const content = await chatCompletion([{ role: 'user', content: parts as never }], 'url_recipe_extraction');

    const lower = content.toLowerCase();
    if (NOT_A_RECIPE_MARKERS.some((m) => lower.includes(m))) throw new NotARecipeError();

    try {
      return decodeExtractedRecipe(extractJsonFromResponse(content));
    } catch (err) {
      if (err instanceof NotARecipeError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error("Couldn't extract a recipe from this page.");
}

/** Transcript fallback for social video posts (mirror of the app's notARecipe catch path). */
async function extractRecipeFromSocialVideo(urlString: string): Promise<ExtractedRecipe> {
  const t = await edgeFunction<{ transcript: string }>('video-transcribe-proxy', { url: urlString }, 180_000);
  if (!t.transcript) throw new NotARecipeError();

  const content = await chatCompletion(
    [
      { role: 'system', content: URL_RECIPE_EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `The following is a transcript from a cooking video. The speaker is demonstrating a recipe and describing ingredients and steps aloud. Extract the recipe from their spoken words.

Note: Spoken recipes may be informal — amounts might be approximate ("a handful of", "some"), steps may not be numbered, and ingredient lists may be woven into the instructions. Do your best to structure the recipe clearly.

Video transcript:
---
${t.transcript}
---`,
      },
    ],
    'transcript_recipe_extraction',
  );

  const lower = content.toLowerCase();
  if (NOT_A_RECIPE_MARKERS.some((m) => lower.includes(m))) throw new NotARecipeError();
  return decodeExtractedRecipe(extractJsonFromResponse(content));
}

export interface LinkImportResult {
  recipe: ExtractedRecipe;
  sourceName: string | null;
}

function platformName(urlString: string): string | null {
  const l = urlString.toLowerCase();
  if (l.includes('instagram.com') || l.includes('instagr.am')) return 'Instagram';
  if (l.includes('facebook.com') || l.includes('fb.com') || l.includes('fb.watch')) return 'Facebook';
  if (l.includes('tiktok.com')) return 'TikTok';
  if (l.includes('pinterest.com') || l.includes('pin.it')) return 'Pinterest';
  if (l.includes('x.com') || l.includes('twitter.com')) return 'X/Twitter';
  return null;
}

/**
 * Web port of the app's link flow for the platforms the shared backend already
 * serves: YouTube (youtube-transcript-proxy + gemini-proxy) and social platforms
 * (scrapingbee-proxy → LLM, with video-transcription fallback). Plain websites
 * need a server-side fetch the backend doesn't expose yet — callers should
 * check classifyLink() first.
 */
export async function extractRecipeFromLink(
  urlString: string,
  onStage?: (stage: string) => void,
): Promise<LinkImportResult> {
  const kind = classifyLink(urlString);

  if (kind === 'youtube') {
    onStage?.('Reading the video…');
    const videoId = extractYouTubeVideoId(urlString)!;
    const recipe = await extractRecipeFromYouTube(urlString, videoId);
    return { recipe, sourceName: 'YouTube' };
  }

  if (kind === 'social') {
    const platform = platformName(urlString);
    onStage?.(`Fetching the ${platform ?? 'social'} post…`);
    const scraped = await edgeFunction<ScrapingBeeResponse>('scrapingbee-proxy', { url: urlString }, 120_000);
    try {
      onStage?.('Extracting the recipe…');
      const recipe = await extractRecipeFromPageContent(urlString, scraped.html);
      return { recipe, sourceName: platform };
    } catch (err) {
      if (!(err instanceof NotARecipeError)) throw err;
      // The post's text had no recipe — try transcribing the video's audio.
      onStage?.('No recipe in the caption — listening to the video…');
      const recipe = await extractRecipeFromSocialVideo(urlString);
      return { recipe, sourceName: platform };
    }
  }

  // Regular websites: server-side fetch via the fetch-page Edge Function
  // (browsers can't read cross-origin HTML), then the same extraction the
  // apps run. A JSON-LD Recipe block, when present, is sent to the model
  // instead of the whole page — smaller, faster, and more faithful.
  onStage?.('Fetching the page…');
  const page = await edgeFunction<{ html: string; finalUrl: string }>('fetch-page', { url: urlString }, 60_000);

  onStage?.('Extracting the recipe…');
  const jsonLd = extractRecipeJsonLd(page.html);
  const content = jsonLd
    ? `Structured recipe data (schema.org JSON-LD) from the page:\n${jsonLd}`
    : page.html;
  const recipe = await extractRecipeFromPageContent(page.finalUrl || urlString, content);

  let sourceName: string | null = null;
  try { sourceName = new URL(page.finalUrl || urlString).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
  return { recipe, sourceName };
}

/**
 * Find a schema.org Recipe node in the page's JSON-LD blocks (handles plain
 * nodes, arrays, and @graph containers). Returns it re-serialized, or null.
 * This is the browser-native equivalent of the apps' StructuredRecipeExtractor
 * fast path — DOMParser does the heavy lifting Swift needed 1900 lines for.
 */
export function extractRecipeJsonLd(html: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }

  const isRecipeNode = (node: unknown): node is Record<string, unknown> => {
    if (!node || typeof node !== 'object') return false;
    const t = (node as Record<string, unknown>)['@type'];
    if (typeof t === 'string') return t.toLowerCase() === 'recipe';
    if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && x.toLowerCase() === 'recipe');
    return false;
  };

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try { parsed = JSON.parse(script.textContent ?? ''); } catch { continue; }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of candidates) {
      if (isRecipeNode(item)) return JSON.stringify(item);
      const graph = (item as Record<string, unknown>)?.['@graph'];
      if (Array.isArray(graph)) {
        const hit = graph.find(isRecipeNode);
        if (hit) return JSON.stringify(hit);
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Background-safe imports via the `import-recipe` Edge Function.
//
// The function runs the whole pipeline server-side (EdgeRuntime.waitUntil), so
// the import survives the tab closing. It responds 202 with the recipe id; the
// complete row appears in `recipes` when the pipeline finishes — the client
// just polls for it. No jobs table exists (deliberate: zero schema change), so
// a server-side failure simply means the row never appears.
// ─────────────────────────────────────────────────────────────────────────────

export type ImportPayload = { id?: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'ai'; mode: 'ingredients' | 'adventurous'; ingredients?: string }
  | { kind: 'photo'; images: string[]; imageUrl?: string | null }
  | { kind: 'link'; url: string }
);

/** Submit an import job; resolves with the recipe id once the server accepts it. */
export async function submitImport(payload: ImportPayload): Promise<string> {
  const res = await edgeFunction<{ accepted: boolean; recipeId: string }>('import-recipe', payload, 60_000);
  if (!res?.accepted || !res.recipeId) throw new Error('The import could not be started — please try again.');
  return res.recipeId;
}

/**
 * Poll `recipes` until the imported row appears. Resolves true when found,
 * false on timeout (the import may STILL complete after — it runs server-side).
 */
export async function waitForRecipe(
  recipeId: string,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  for (;;) {
    const { data } = await supabase.from('recipes').select('id').eq('id', recipeId).maybeSingle();
    if (data?.id) return true;
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return false;
    opts.onTick?.(elapsed);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Transform via the `transform-recipe` Edge Function.
//
// Web port of the apps' AI Transform (AITransformView): convert a saved recipe
// to a dietary style or per a custom instruction, saving the result as a new
// recipe or replacing the original. Same background contract as imports: the
// function responds 202 and finishes server-side, so the transform survives
// the tab closing. Completion is detected by polling `recipes` — the new row
// appearing ('new') or `updated_at` moving ('replace').
// ─────────────────────────────────────────────────────────────────────────────

export interface TransformPayload {
  recipeId: string;
  /** Preset name (DietaryConversion.rawValue, e.g. 'Vegan') or 'Custom'. */
  conversion?: string;
  /** Required when conversion is 'Custom' (or omitted). */
  customPrompt?: string;
  target: 'new' | 'replace';
  generateImage?: boolean;
}

/** Submit a transform job; resolves with the target recipe id once accepted. */
export async function submitTransform(payload: TransformPayload): Promise<string> {
  const res = await edgeFunction<{ accepted: boolean; recipeId: string }>('transform-recipe', payload, 60_000);
  if (!res?.accepted || !res.recipeId) throw new Error('The transformation could not be started — please try again.');
  return res.recipeId;
}

/**
 * Poll `recipes` until the row's `updated_at` moves past the given baseline
 * (replace-mode completion). Resolves true when it moves, false on timeout
 * (the transform may STILL complete after — it runs server-side).
 */
export async function waitForRecipeUpdate(
  recipeId: string,
  baselineUpdatedAt: string | null,
  opts: { timeoutMs?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  for (;;) {
    const { data } = await supabase.from('recipes').select('updated_at').eq('id', recipeId).maybeSingle();
    if (data?.updated_at && data.updated_at !== baselineUpdatedAt) return true;
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) return false;
    opts.onTick?.(elapsed);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
