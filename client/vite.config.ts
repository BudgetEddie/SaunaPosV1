// =============================================================================
// BUILD SETTINGS FOR THE CLIENT.
//
// WHAT VITE IS
//   The tool that runs the client. It does two jobs:
//     `npm run dev`    serves the app while you work, and pushes changes into
//                      the browser the instant you save a file
//     `npm run build`  packs everything into a `dist` folder for a real server
//
// WHY THIS FILE IS NEARLY EMPTY
//   The defaults are all correct here, so there's nothing to override. Two
//   things worth knowing are settled by those defaults:
//     - the app is served on port 5173
//     - there's no proxy set up, so the client talks to the server directly at
//       the address hardcoded in client/src/authFetch.ts. That's the one place
//       to change when moving the server somewhere else.
// =============================================================================

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Teaches Vite to understand React's .tsx files. Without this the HTML-like
  // markup inside the components would be a syntax error.
  plugins: [react()],
})
