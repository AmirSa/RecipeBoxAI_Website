import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || 'https://usrgdiakvnegybqfhcmb.supabase.co';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVzcmdkaWFrdm5lZ3licWZoY21iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc4NjEyMTMsImV4cCI6MjA3MzQzNzIxM30.dDqM7KevNrOyg-demi11SNIpVOY6Iw-nRatQWySOokg';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Types matching the Supabase schema
export interface SharedRecipeListItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  prep_time: number;
  cook_time: number;
  servings: number;
  calories: number;
  tags: Record<string, string>;
  auto_tags: string[];
  image_url: string | null;
  is_featured: boolean;
  view_count: number;
  add_count: number;
}

export interface RecipeSection {
  title: string;
  ingredients: RecipeIngredient[];
}

export interface RecipeIngredient {
  amount: string | null;
  unit: string | null;
  name: string;
  preparation: string | null;
}

export interface RecipeInstruction {
  id?: string;
  stepNumber: number;
  instruction: string;
}

export interface RichNutrient {
  name: string;
  type: string;
  amount: string;
  description: string;
}

export interface RecipeNutrition {
  protein?: number;
  fat?: number;
  carbs?: number;
  fiber?: number;
  sugar?: number;
  sodium?: number;
  richNutrients?: RichNutrient[];
}

export interface SharedRecipe {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  prep_time: number;
  cook_time: number;
  servings: number;
  calories: number;
  notes: string | null;
  sections: RecipeSection[];
  instructions: RecipeInstruction[];
  tags: Record<string, string>;
  auto_tags: string[];
  nutrition: RecipeNutrition;
  image_url: string | null;
  is_featured: boolean;
  view_count: number;
  add_count: number;
  created_at: string;
}

// Fetch all published recipes for the list page
export async function getSharedRecipesList(): Promise<SharedRecipeListItem[]> {
  const { data, error } = await supabase
    .rpc('get_shared_recipes_list', {
      p_limit: 100,
      p_offset: 0
    });
  
  if (error) {
    console.error('Error fetching recipes list:', error);
    return [];
  }
  
  return data || [];
}

// Fetch a single recipe by slug
export async function getSharedRecipeBySlug(slug: string): Promise<SharedRecipe | null> {
  const { data, error } = await supabase
    .rpc('get_shared_recipe_by_slug', {
      recipe_slug: slug
    });
  
  if (error) {
    console.error('Error fetching recipe:', error);
    return null;
  }
  
  return data?.[0] || null;
}

// Get all recipe slugs for static generation
export async function getAllRecipeSlugs(): Promise<string[]> {
  const { data, error } = await supabase
    .from('shared_recipes')
    .select('slug')
    .eq('is_published', true);
  
  if (error) {
    console.error('Error fetching slugs:', error);
    return [];
  }
  
  return data?.map(r => r.slug) || [];
}
