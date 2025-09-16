# Email Redirect Page

This folder contains a simple HTML page that handles email confirmation redirects for RecipeBox AI.

## Quick Deployment Options

### Option 1: Netlify (Recommended)
1. Create a free account at [Netlify](https://netlify.com)
2. Drag and drop this `email-redirect` folder to Netlify
3. Your site will be available at: `https://amazing-name-123456.netlify.app`
4. You can customize the domain name in Netlify settings

### Option 2: Vercel
1. Create a free account at [Vercel](https://vercel.com)
2. Connect your GitHub repo or upload this folder
3. Your site will be available at: `https://recipeboxai-email.vercel.app`

### Option 3: GitHub Pages
1. Create a new GitHub repository called `recipeboxai-email`
2. Upload the `index.html` file
3. Enable GitHub Pages in repository settings
4. Your site will be available at: `https://yourusername.github.io/recipeboxai-email`

## Usage

Once deployed, use this URL format in your Supabase email template:
```
https://your-deployed-url.com/?token_hash={{ .TokenHash }}&type=signup
```

For example:
```
https://recipeboxai-email.netlify.app/?token_hash={{ .TokenHash }}&type=signup
```

## Features

- ✅ Mobile-first design
- ✅ Automatic app detection and opening
- ✅ Fallback for manual app opening
- ✅ App Store links for new users
- ✅ Desktop-friendly messaging
- ✅ Professional RecipeBox AI branding