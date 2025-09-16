# Email Redirect Page for RecipeBox AI

This folder contains a simple HTML page that handles email confirmation redirects for RecipeBox AI.

## 🌐 Your Domain: https://recipeboxai.app/

## Quick Deployment Options

### Option 1: Netlify with Custom Domain (Recommended)
1. Keep your existing Netlify deployment
2. In Netlify dashboard → Domain settings
3. Add custom domain: `recipeboxai.app`
4. Configure DNS as instructed by Netlify
5. Your redirect page will be available at: `https://recipeboxai.app/`

### Option 2: Upload to Your Hosting
1. Upload `index.html` to your web hosting
2. Place it at: `https://recipeboxai.app/auth/confirm/`
3. Ensure it's accessible via the URL above

### Option 3: Vercel with Custom Domain
1. Deploy to Vercel
2. Add custom domain in Vercel dashboard
3. Configure DNS settings as instructed

## Usage

Once deployed, use this URL format in your Supabase email template:
```
https://recipeboxai.app/auth/confirm?token_hash={{ .TokenHash }}&type=signup
```

## Features

- ✅ Mobile-first design
- ✅ Automatic app detection and opening
- ✅ Fallback for manual app opening
- ✅ App Store links for new users
- ✅ Desktop-friendly messaging
- ✅ Professional RecipeBox AI branding