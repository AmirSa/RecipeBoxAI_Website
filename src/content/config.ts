import { z, defineCollection } from 'astro:content';

// Recipe schema - defines the structure of all recipe data
const recipeSchema = z.object({
  title: z.string(),
  description: z.string(),
  image: z.string().url(),
  prepTime: z.number(), // in minutes
  cookTime: z.number(), // in minutes
  servings: z.number(),
  calories: z.number(),
  
  // Categories and tags
  category: z.string(),
  cuisine: z.string(),
  tags: z.array(z.string()),
  
  // Nutrition information
  nutrition: z.object({
    protein: z.number(),
    fat: z.number(),
    carbs: z.number(),
    fiber: z.number().optional(),
  }),
  
  // Rich nutrients (optional)
  nutrients: z.array(z.object({
    name: z.string(),
    value: z.string(),
    description: z.string(),
    icon: z.string().optional(),
    color: z.enum(['yellow', 'red', 'blue', 'green']).optional(),
  })).optional(),
  
  // Ingredients
  ingredients: z.array(z.object({
    amount: z.string().optional(),
    name: z.string(),
    note: z.string().optional(),
  })),
  
  // Instructions
  instructions: z.array(z.string()),
  
  // Chef's notes / overview
  overview: z.string().optional(),
  
  // Additional photos
  photos: z.array(z.string().url()).optional(),
  
  // Schema.org metadata
  keywords: z.string().optional(),
});

const recipesCollection = defineCollection({
  type: 'data',
  schema: recipeSchema,
});

export const collections = {
  recipes: recipesCollection,
};

export type Recipe = z.infer<typeof recipeSchema>;
