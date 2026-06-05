import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: './widget-ui',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../dist/widget-ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'hotel-search': './widget-ui/hotel-search.html',
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
