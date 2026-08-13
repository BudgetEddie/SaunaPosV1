// ============================================================================
// THE STARTING PISTOL — the very first client code that runs.
//
// WHAT IT IS
//   Two jobs, nothing else. It plants the app into the empty page, and it
//   lists which web address shows which screen.
//
// WHERE IT'S USED
//   Loaded by client/index.html (the <script> tag at the bottom). Nothing in
//   the app imports this file — it's the top of the tree, not a branch.
//
// WHAT IT PULLS IN
//   Every screen in the app, plus index.css. Because they're all imported
//   here and none of them are loaded lazily, all seven screens start up the
//   moment the app opens — including their live socket connections.
//
// (New to React? See CODE-GUIDE.md in the project root.)
// ============================================================================

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Shell from "./Shell.tsx";
import Home from "./Home.tsx";
import CustomerDirectory from "./CustomerDirectory.tsx";
import PointOfSale from "./PointOfSale.tsx";
import Kitchen from "./Kitchen.tsx";
import Lockers from "./Lockers.tsx";
import Tables from "./Tables.tsx";
import Reports from "./Reports.tsx";
import MenuPage from "./MenuPage.tsx";
import Receipt from "./Receipt.tsx";
import { OverrideProvider } from "./OverrideProvider.tsx";
import { DialogProvider } from "./DialogProvider.tsx";
import { start as startClickSound } from "./clickSound.ts";

// The tap sound. Attached once, at the document level, rather than being wired
// into each screen — there are hundreds of tappable things and adding a line to
// every one would be a tax on every future change. See clickSound.ts.
startClickSound();

// Find the empty <div id="root"> in index.html and hand it to React. From here
// on, everything on screen is drawn by React into that one box.
//
// StrictMode is a development-only helper: it deliberately runs some code twice
// to surface sloppy patterns. It disappears in the built version, so if you see
// something happen twice while developing, this is usually why.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* DialogProvider owns every "are you sure?", "type a name" and "that
        didn't work" box in the app — the ones that used to be the browser's
        own pop-ups, until the browser started silently refusing to show them.
        Outside OverrideProvider on purpose: an error box can follow a manager
        password box, so it has to be able to sit on top of one. */}
    <DialogProvider>
      {/* OverrideProvider owns the manager-password prompt. It sits out here,
          above the router, so the modal survives navigation and so ANY screen
          can summon it with useOverride() without passing props down. It draws
          nothing until a screen asks. */}
      <OverrideProvider>
        {/* BrowserRouter is what makes the address bar work without full page
            reloads — clicking "Kitchen" swaps the screen and updates the URL,
            but the browser never actually re-downloads the app. */}
        <BrowserRouter>
          <Routes>
            {/* The receipt sits OUTSIDE the Shell below, on purpose: it opens in
                its own browser tab for printing, so it must not come with a
                sidebar attached. That also means it doesn't inherit the Shell's
                sign-in gate, which is why Receipt.tsx checks for a token itself. */}
            <Route path="/receipt/:billId" element={<Receipt />} />

            {/* Everything below is wrapped in the Shell — so every one of these
                gets the sidebar, and none is reachable unless someone is signed
                in. Shell.tsx decides which. (Deliberately not counted here: the
                number was already wrong before Tables was added.) */}
            <Route element={<Shell />}>
              <Route path="/" element={<Home />} />
              <Route path="/customers" element={<CustomerDirectory />} />
              <Route path="/pos" element={<PointOfSale />} />
              <Route path="/kitchen" element={<Kitchen />} />
              <Route path="/lockers" element={<Lockers />} />
              <Route path="/tables" element={<Tables />} />
              {/* These last two need admin rights. Staff can now open them and
                  ask a manager for a password, rather than being turned away —
                  but the real enforcement is still on the server, which refuses
                  the data without either an admin login or an approval. */}
              <Route path="/reports" element={<Reports />} />
              <Route path="/menu" element={<MenuPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </OverrideProvider>
    </DialogProvider>
  </StrictMode>
);