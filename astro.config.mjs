import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://recipeboxai.app',
  integrations: [sitemap()],
  output: 'static',
  build: {
    format: 'directory'
  },
  image: {
    domains: ['usrgdiakvnegybqfhcmb.supabase.co'],
    remotePatterns: [{ protocol: 'https' }]
  }
});
