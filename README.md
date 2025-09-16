# Netlify Deployment for RecipeBox AI Email Confirmation

This folder contains the proper structure for deploying to Netlify to serve your email confirmation page at `https://recipeboxai.app/auth/confirm`.

## 📁 Folder Structure

```
netlify-deploy/
├── auth/
│   └── confirm/
│       └── index.html        # Email confirmation redirect page
└── _redirects               # Netlify redirect rules (optional)
```

## 🚀 Deployment Steps

### Option 1: Upload New Structure (Recommended)

1. **Delete your current Netlify deployment** (or create a new site)
2. **Drag and drop this entire `netlify-deploy` folder** to Netlify
3. **Configure custom domain** in Netlify dashboard:
   - Go to Domain settings
   - Add custom domain: `recipeboxai.app`
   - Follow DNS configuration instructions

### Option 2: Update Existing Deployment

1. In your current Netlify site dashboard
2. Go to **Deploys** tab
3. Drag and drop this `netlify-deploy` folder to deploy

## 🌐 Result

After deployment, your email confirmation page will be available at:
- `https://recipeboxai.app/auth/confirm`
- `https://recipeboxai.app/auth/confirm/`

Both URLs will work and serve the same page.

## ✅ Testing

Test the page by visiting:
```
https://recipeboxai.app/auth/confirm?token_hash=test123&type=signup
```

You should see the RecipeBox AI confirmation page with the test parameters.

## 🔧 DNS Configuration

If you haven't set up your custom domain yet:

1. **In Netlify dashboard:**
   - Domain settings → Add custom domain → `recipeboxai.app`

2. **In your domain registrar (where you bought recipeboxai.app):**
   - Add CNAME record: `www` → `your-netlify-site.netlify.app`
   - Add A record: `@` → Netlify's IP (they'll provide this)

## 🧪 Supabase Configuration

Update your Supabase email template to use:
```
https://recipeboxai.app/auth/confirm?token_hash={{ .TokenHash }}&type=signup
```