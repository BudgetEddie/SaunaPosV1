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
//   The defaults are all correct here, so there's almost nothing to override.
//   One thing worth knowing is settled by those defaults:
//     - there's no proxy set up, so the client talks to the server directly.
//       The address comes from VITE_SERVER_ORIGIN — client/.env.development
//       sets it to port 4000 while you work. `npm run build` ignores that file,
//       leaving the address empty, which is what a real server wants: it serves
//       the client itself, so the browser just uses whatever host it came from.
// =============================================================================

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Teaches Vite to understand React's .tsx files. Without this the HTML-like
  // markup inside the components would be a syntax error.
  plugins: [react()],
  server: {
    // Still 5173 normally — that hasn't changed. The only difference is that
    // something starting this app can now hand it a different port instead,
    // which matters when 5173 is already taken by another project on the same
    // machine. Vite doesn't look at PORT on its own; this is what teaches it to.
    //
    // NOTE this is only the address the app itself is served on. It has nothing
    // to do with the SERVER on port 4000 — that address comes from
    // VITE_SERVER_ORIGIN in client/.env.development, and is read by
    // client/src/authFetch.ts.
    port: Number(process.env.PORT) || 5173,
  },
})
