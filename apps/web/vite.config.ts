import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(() => {
  const environment = loadEnv('', fileURLToPath(new URL('../..', import.meta.url)), '');
  return {
    plugins: [vue()],
    server: {
      host: '127.0.0.1',
      port: Number(environment.WEB_PORT || 5173),
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${environment.PORT || 3000}` },
    },
  };
});
