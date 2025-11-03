# Netlify Deployment for RecipeBox AI

This folder contains the complete structure for deploying to Netlify to serve your RecipeBox AI web pages.

## 📁 Folder Structure

```
netlify-deploy/
├── index.html               # Main landing page
├── auth/
│   ├── confirm/
│   │   └── index.html        # Email confirmation redirect page
│   └── reset-password/
│       └── index.html        # Password reset redirect page
├── terms/
│   └── index.html           # Terms & Conditions page
├── privacy/
│   └── index.html           # Privacy Policy page
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

After deployment, your pages will be available at:
- **Main site**: `https://recipeboxai.app/` (landing page)
- **Email confirmation**: `https://recipeboxai.app/auth/confirm`
- **Password reset**: `https://recipeboxai.app/auth/reset-password`
- **Terms & Conditions**: `https://recipeboxai.app/terms`
- **Privacy Policy**: `https://recipeboxai.app/privacy`

## ✅ Testing

Test the pages by visiting:
- **Main landing page**: `https://recipeboxai.app/`
- **Email confirmation**: `https://recipeboxai.app/auth/confirm?token_hash=test123&type=signup`
- **Password reset**: `https://recipeboxai.app/auth/reset-password?token_hash=test123&type=recovery`
- **Terms & Conditions**: `https://recipeboxai.app/terms`
- **Privacy Policy**: `https://recipeboxai.app/privacy`

You should see the respective RecipeBox AI pages.

## 🔧 DNS Configuration

If you haven't set up your custom domain yet:

1. **In Netlify dashboard:**
   - Domain settings → Add custom domain → `recipeboxai.app`

2. **In your domain registrar (where you bought recipeboxai.app):**
   - Add CNAME record: `www` → `your-netlify-site.netlify.app`
   - Add A record: `@` → Netlify's IP (they'll provide this)

## 🧪 Supabase Configuration

**For Email Confirmation:**
Update your Supabase email confirmation template to use:
```
https://recipeboxai.app/auth/confirm?token_hash={{ .TokenHash }}&type=signup
```

**For Password Reset:**
Update your Supabase password reset template to use:
```
https://recipeboxai.app/auth/reset-password?token_hash={{ .TokenHash }}&type=recovery
```