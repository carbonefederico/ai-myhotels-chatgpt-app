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
        'myhotels-widget': './widget-ui/myhotels-widget.html',
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
