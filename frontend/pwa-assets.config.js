import { defineConfig } from '@vite-pwa/assets-generator/config';

export default defineConfig({
  headLinkOptions: {
    preset: 'reuse',
  },
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, 'favicon-48.png'], [64, 'favicon.png']],
    },
    maskable: {
      sizes: [512],
      padding: 0.1,
    },
    apple: {
      sizes: [180],
      padding: 0.1,
    },
  },
  images: ['public/icon.svg'],
});
