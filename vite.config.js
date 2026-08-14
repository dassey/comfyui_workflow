import { defineConfig } from 'vite';

// Served from https://<user>.github.io/comfyui_workflow/ by default. Override
// with BASE_PATH=/ when serving from a domain root or a different sub-path.
export default defineConfig({
  base: process.env.BASE_PATH || '/comfyui_workflow/',
});
