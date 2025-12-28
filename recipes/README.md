# Recipe Website - Implementation Guide

## Overview
This implementation creates a recipe sharing system where users can discover recipes on the RecipeBox AI website and add them directly to their app via deep links.

## Current Status
✅ **Phase 1-3 Complete**: Core infrastructure ready
- Recipe JSON structure defined
- Website pages created (browse + individual recipe template)
- Deep link handler implemented in iOS app
- Sample recipes created (5 out of 100)

🔄 **Phase 4 In Progress**: Need to generate remaining 95 recipes

## Architecture

### Website Structure
```
netlify-deploy/
├── index.html                    # Homepage with link to recipes
├── robots.txt                    # SEO: Search engine directives
├── sitemap.xml                   # SEO: All URLs for search engines
├── recipes/
│   ├── index.html               # Recipe browse page with filters
│   ├── data/
│   │   ├── recipes-master.json  # Lightweight list for browse page
│   │   └── *.json               # Full recipe data files
│   └── {recipe-slug}/
│       └── index.html           # Individual recipe page
```

### Recipe JSON Format
Matches `OpenAIRecipeResponse` structure from iOS app:
- `title`, `prepTime`, `cookTime`, `servings`, `calories`, `notes`
- `sections[]` with `ingredients[]`
- `instructions[]` with step numbers
- `tags` (mealType, cuisine, diet)
- `autoTags[]`
- `nutrition` (protein, fat, carbs, richNutrients)

### Deep Link Flow
1. User clicks "Add to My RecipeBox" button on website
2. JavaScript fetches full recipe JSON from `/data/{slug}.json`
3. JSON is URL-encoded and passed via deep link
4. Deep link format: `stage4.recipebox-ai-v5://recipe/add?json={encoded-json}`
5. iOS app receives URL in `RecipeBoxAI_V5App.swift`
6. `handleRecipeImport()` decodes JSON and saves to Core Data via `RecipeStore.createRecipe()`

## SEO Features
- ✅ Schema.org Recipe markup on individual pages
- ✅ Open Graph meta tags for social sharing
- ✅ Sitemap.xml for search engines
- ✅ Robots.txt configuration
- ✅ Semantic HTML structure
- ✅ Mobile-responsive design
- ✅ Fast loading (static HTML)

## How to Add More Recipes

### Option 1: Manual Creation
1. Create full recipe JSON in `netlify-deploy/recipes/data/{slug}.json`
2. Add entry to `recipes-master.json`
3. Create folder `netlify-deploy/recipes/{slug}/`
4. Copy `chicken-tikka-masala/index.html` as template
5. Update recipe details in HTML
6. Add URL to `sitemap.xml`

### Option 2: Automated Generation (Recommended)
Use the Python script in `scripts/generate_recipes.py`:

```bash
cd scripts
python3 generate_recipes.py
```

This will:
- Generate 100 recipe JSON files
- Create recipes-master.json
- Output files ready to be placed in website

### Recipe Categories Needed (95 remaining)

**Breakfast (8 more)**
- Waffles, French Toast, Smoothie Bowl, Oatmeal, Breakfast Burrito, Eggs Benedict, Shakshuka, Breakfast Hash

**Lunch (13 more)**
- Greek Salad, Caprese Sandwich, Club Sandwich, BLT, Chicken Wrap, Tuna Salad, Quinoa Bowl, Buddha Bowl, Chicken Noodle Soup, Tomato Soup, Minestrone, Grilled Cheese, Quesadilla

**Dinner - Chicken (11 more)**
- Chicken Parmesan, Grilled Chicken, Chicken Stir Fry, Chicken Fajitas, Chicken Alfredo, Roasted Chicken, Chicken Curry, Lemon Chicken, Teriyaki Chicken, BBQ Chicken, Chicken Shawarma

**Dinner - Beef (8 more)**
- Beef Tacos, Beef Stew, Meatballs, Hamburger, Beef Stroganoff, Beef Wellington, Steak, Pot Roast

**Dinner - Seafood (8 more)**
- Salmon, Shrimp Scampi, Fish Tacos, Tuna Poke Bowl, Grilled Tilapia, Clam Chowder, Fish and Chips, Paella

**Dinner - Vegetarian (10 more)**
- Vegetable Curry, Eggplant Parmesan, Veggie Burger, Falafel, Ratatouille, Vegetable Lasagna, Margherita Pizza, Mushroom Risotto, Stuffed Bell Peppers, Veggie Stir Fry

**Dinner - Pasta (7 more)**
- Penne Arrabbiata, Fettuccine Alfredo, Lasagna, Mac and Cheese, Pesto Pasta, Bolognese, Ravioli

**Desserts (10 more)**
- Chocolate Chip Cookies, Brownies, Cheesecake, Tiramisu, Apple Pie, Chocolate Cake, Cupcakes, Ice Cream, Crème Brûlée, Panna Cotta

**Snacks & Appetizers (10 more)**
- Guacamole, Hummus, Bruschetta, Spring Rolls, Nachos, Mozzarella Sticks, Deviled Eggs, Chips and Salsa, Chicken Wings, Stuffed Mushrooms

**International (10 more)**
- Sushi Rolls, Bibimbap, Ramen, Tacos al Pastor, Butter Chicken, Moussaka, Beef Pho, Lamb Gyro, Chicken Satay, Paella

## Testing

### Local Testing
1. Open `netlify-deploy/recipes/index.html` in browser
2. Click on a recipe
3. Click "Add to My RecipeBox" button
4. If testing on Mac simulator:
   - Build and run RecipeBoxAI_V5 app
   - When deep link triggers, app should open and recipe should be added

### Production Testing
1. Deploy to Netlify
2. Visit https://recipeboxai.app/recipes/
3. Browse recipes
4. Click "Add to My RecipeBox" on any recipe
5. App should open on your iPhone and import the recipe

## Future Enhancements
- [ ] Generate remaining 95 recipes
- [ ] Add recipe images (AI-generated or stock photos)
- [ ] Implement recipe search functionality
- [ ] Add user ratings/reviews
- [ ] Create recipe collections/categories
- [ ] Add print-friendly recipe view
- [ ] Implement recipe sharing to social media
- [ ] Add recipe difficulty indicators
- [ ] Create video cooking tutorials
- [ ] Add nutritional information filters

## Files Modified

### iOS App
- `RecipeBoxAI_V5/RecipeBoxAI_V5App.swift` - Added recipe deep link handler

### Website
- `netlify-deploy/index.html` - Added "Browse Recipes" section
- `netlify-deploy/recipes/index.html` - Recipe browse page (NEW)
- `netlify-deploy/recipes/chicken-tikka-masala/index.html` - Recipe template (NEW)
- `netlify-deploy/recipes/data/recipes-master.json` - Recipe metadata (NEW)
- `netlify-deploy/recipes/data/chicken-tikka-masala.json` - Full recipe JSON (NEW)
- `netlify-deploy/sitemap.xml` - SEO sitemap (NEW)
- `netlify-deploy/robots.txt` - Search engine directives (NEW)

### Documentation
- `RECIPE_SHARING_IMPLEMENTATION_PLAN.md` - Detailed implementation plan
- `netlify-deploy/recipes/README.md` - This file

## Support
For questions or issues, refer to:
- Implementation Plan: `RECIPE_SHARING_IMPLEMENTATION_PLAN.md`
- Recipe JSON format: Check `RecipeBoxAI_V5/Models/RecipeData.swift`
- Deep link handling: Check `RecipeBoxAI_V5/RecipeBoxAI_V5App.swift`
