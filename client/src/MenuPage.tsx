// ============================================================================
// THE MENU EDITOR — what the bathhouse sells. ADMIN ONLY.
//
// WHAT IT IS
//   Everything that appears as a tile on the till, and the categories those
//   tiles are grouped into. Add items, set prices and tax, upload a photo,
//   hide something that's run out, and set the house default tax rate.
//
//   Changes here reach every terminal within a second — the server broadcasts
//   "menu:updated" and the till refetches its menu.
//
// WHERE IT'S USED
//   The "/menu" route in client/src/main.tsx. Nothing imports it.
//   Like Reports, the sidebar hides the link from non-admins and this screen
//   re-checks, but the server is what actually refuses.
//
// WHAT IT TALKS TO   (all in server/src/index.ts, all admin-only)
//   GET    /categories                 → the whole menu tree
//   GET    /settings                   → the house default tax rate
//   POST   /categories                 → add a category
//   PUT    /categories/:id             → rename / regroup a category
//   DELETE /categories/:id             → remove an (empty) category
//   POST   /menu-items                 → add an item
//   PUT    /menu-items/:id             → save an item
//   DELETE /menu-items/:id             → delete an item
//   POST   /menu-items/:id/available   → the On sale / Hidden switch
//   PUT    /settings                   → save the default tax rate
// ============================================================================

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { useOverride } from "./OverrideProvider.tsx";
import { useDialog } from "./DialogProvider.tsx";
import { type Category, type MenuItem } from "./types.ts";

const socket = io("http://localhost:4000");

// The two halves of the menu. Which one a category is in has a real
// consequence: FOOD_DRINK categories print kitchen tickets, MERCH_SERVICE
// ones don't. The server sets that automatically from the group.
const GROUPS = [
  { id: "FOOD_DRINK", label: "Food & drinks", dot: "#7a6a53" },
  { id: "MERCH_SERVICE", label: "Merchandise & services", dot: "#a89a86" },
];

// The item currently open in the editor panel.
//
// Note the prices and tax are held as TEXT, not numbers. That's because a
// half-typed "12." isn't a valid number, and forcing it into one as the user
// types would fight them. It's converted on save instead.
//
// Also note `taxPercent`: staff think in "13%", the database stores 0.13. The
// conversion happens right here at the edge — divided by 100 on save,
// multiplied by 100 on load — so nothing else has to think about it.
type Draft = {
  id: number | null;
  categoryId: string;
  name: string;
  price: string;
  taxPercent: string;
  description: string;
  imageData: string | null;
  available: boolean;
  sendsToKitchen: boolean;
  visitCredits: string;
  redeemsPass: boolean;
  // "" means an ordinary item. Held as text like price and tax, so a
  // half-typed figure doesn't get forced into a number as you type.
  discountKind: "" | "FIXED" | "PERCENT";
  discountValue: string;
};

const LABEL: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "#a89a86",
  marginBottom: 7,
};
const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 16,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const CHIP_BTN: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 800,
  color: "#7a6a53",
  border: "1.5px solid #d8cebc",
  borderRadius: 8,
  padding: "5px 11px",
  cursor: "pointer",
  background: "#fffdf9",
  fontFamily: "inherit",
};

function money(n: number) {
  // Discounts are negative, and "$-5.00" reads like a typo. Put the minus in
  // front of the whole thing — "−$5.00" — the way a receipt would.
  return n < 0 ? `−$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}
// A fresh, empty item — new items start on sale and at the house tax rate.
function blankDraft(categoryId: number, defaultTaxPercent: string): Draft {
  return {
    id: null,
    categoryId: String(categoryId),
    name: "",
    price: "",
    taxPercent: defaultTaxPercent,
    description: "",
    imageData: null,
    available: true,
    sendsToKitchen: true,
    visitCredits: "0",
    redeemsPass: false,
    discountKind: "",
    discountValue: "",
  };
}

function MenuPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [defaultTaxPercent, setDefaultTaxPercent] = useState("13.00");
  // The cash discount, both in dollars. Kept as text while being typed — the
  // boxes have to tolerate a half-finished "1" on the way to "15".
  const [cashDiscount, setCashDiscount] = useState("0.00");
  const [cashDiscountMinEntry, setCashDiscountMinEntry] = useState("0.00");
  const [loadedSettings, setLoadedSettings] = useState(false);
  const [query, setQuery] = useState("");                       // item search
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);       // the editor panel
  const [catFormGroup, setCatFormGroup] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";
  const askOverride = useOverride();
  const dialog = useDialog();

  // Set while a delete or a rename is mid-flight. The message boxes are drawn
  // by the app now rather than by the browser, and the browser's ones used to
  // freeze everything until answered — which quietly meant a second click
  // couldn't land. It can now, so this says no to it.
  const acting = useRef(false);

  // Like Reports, this is a screen you enter to do admin work, so it unlocks
  // once rather than prompting on every save. "" for an admin who needs no
  // approval, a token once a manager approves, null while still locked.
  const [approval, setApproval] = useState<string | null>(isAdmin ? "" : null);
  // Set when the server refuses — which is what happens when the ten minutes
  // lapse mid-edit. Without this the page would keep alerting with no way back.
  const [expired, setExpired] = useState(false);

  const unlock = async () => {
    const token = await askOverride("Edit the menu", "PAGE");
    if (token === null) return;
    setApproval(token);
    setExpired(false);
  };

  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);

  useEffect(() => {
    if (approval === null) return;
    loadMenu();
    authFetch(`/settings`).then((r) => r.json()).then((s) => {
      // Only take the saved rate the first time. Without this guard, a later
      // refetch would wipe out a rate being typed but not yet saved.
      if (!loadedSettings) {
        setDefaultTaxPercent((s.taxRate * 100).toFixed(2));
        setCashDiscount(s.cashDiscount.toFixed(2));
        setCashDiscountMinEntry(s.cashDiscountMinEntry.toFixed(2));
        setLoadedSettings(true);
      }
    });
    // Another admin (or another tab) editing the menu refreshes this one too.
    socket.on("menu:updated", loadMenu);
    return () => {
      socket.off("menu:updated", loadMenu);
    };
    // The linter wants more listed here; deliberately left out so this runs
    // only once rather than on every redraw. `approval` IS listed, because
    // the menu has to actually load once a manager unlocks it — without it
    // this effect would never re-run and the page would stay empty forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval]);

  if (approval === null) {
    return (
      <div style={{ background: "#f4efe7", minHeight: "100vh", padding: 26 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Menu</h1>
        <p style={{ color: "#a89a86", fontWeight: 600, maxWidth: 380, lineHeight: 1.5 }}>
          {expired
            ? "That approval has run out. A manager can open it again."
            : "Changing prices needs a manager's approval."}
        </p>
        <button className="ov-btn ov-go" style={{ maxWidth: 220 }} onClick={unlock}>
          Ask a manager
        </button>
      </div>
    );
  }

  const showError = async (res: Response) => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // The approval lapsed mid-edit. Lock the screen and offer the prompt
      // again rather than alerting on every subsequent save with no way back.
      if (res.status === 403 && body.needsOverride) {
        setApproval(isAdmin ? "" : null);
        setExpired(true);
        return false;
      }
      await dialog.say(body.error, { title: "That didn't work" });
    }
    return res.ok;
  };

  const editItem = (item: MenuItem) => {
    setCatFormGroup(null);
    setDraft({
      id: item.id,
      categoryId: String(item.categoryId),
      name: item.name,
      price: String(item.price),
      taxPercent: (item.taxRate * 100).toFixed(2),
      description: item.description ?? "",
      imageData: item.imageData,
      available: item.available,
      sendsToKitchen: item.sendsToKitchen,
      discountKind: (item.discountKind === "FIXED" || item.discountKind === "PERCENT") ? item.discountKind : "",
      discountValue: item.discountKind ? String(item.discountValue) : "",
      visitCredits: String(item.visitCredits),
      redeemsPass: item.redeemsPass,
    });
  };

  const newItem = async (categoryId?: number) => {
    const target = categoryId ?? categories[0]?.id;
    if (!target) {
      await dialog.say("Add a category first.");
      return;
    }
    setCatFormGroup(null);
    setCollapsed((prev) => ({ ...prev, [target]: false }));
    setDraft(blankDraft(target, defaultTaxPercent));
  };

  // Shrink the picture in the browser before it ever reaches the server: a 4MB
  // phone photo becomes roughly 40KB, which is small enough to keep in the
  // database alongside the item.
  //
  // There's no file upload anywhere in this app — no folder of images, nothing
  // to back up separately. The shrunk photo is turned into a (long) piece of
  // text and saved in the database like any other field.
  //
  // It happens in four steps, each waiting on the one before:
  //   1. FileReader reads the chosen file off the disk.
  //   2. An Image object decodes it so we can see how big it is.
  //   3. A canvas — an off-screen drawing surface — redraws it at 400px.
  //   4. toDataURL turns that canvas back into text at 80% JPEG quality.
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    // Nothing inside here runs immediately — it waits until the file has
    // actually been read, which is why it's written as nested callbacks.
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Scale the longest side down to 400px, keeping the proportions.
        // Math.min with 1 means a photo already smaller is left alone rather
        // than being blown up.
        const max = 400;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const shrunk = canvas.toDataURL("image/jpeg", 0.8);
        setDraft((d) => (d ? { ...d, imageData: shrunk } : d));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // so picking the same file twice still fires
  };

  const saveItem = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      await dialog.say("Give the item a name.");
      return;
    }
    const price = parseFloat(draft.price);
    if (Number.isNaN(price)) {
      await dialog.say("Give the item a price.");
      return;
    }
    // Turn the typed text back into the shapes the database wants — notably
    // the tax percentage back into a decimal (13 → 0.13).
    const body = {
      categoryId: Number(draft.categoryId),
      name: draft.name.trim(),
      price,
      description: draft.description.trim() || null,
      taxRate: (parseFloat(draft.taxPercent) || 0) / 100,
      imageData: draft.imageData,
      available: draft.available,
      sendsToKitchen: draft.sendsToKitchen,
      discountKind: draft.discountKind || null,
      discountValue: parseFloat(draft.discountValue) || 0,
      visitCredits: parseInt(draft.visitCredits, 10) || 0,
      redeemsPass: draft.redeemsPass,
    };
    // An item with an id already exists, so update it; one without is new.
    // That's the only difference between the two branches.
    const res = draft.id
      ? await authFetch(`/menu-items/${draft.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, approval)
      : await authFetch(`/menu-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, approval);
    if (!(await showError(res))) return;
    setDraft(null);
    loadMenu();
  };

  // Delete an item from the menu. Past bills are genuinely unaffected: a
  // charge stores the name and price as text at the moment of sale rather than
  // pointing back at the menu, so old receipts keep working forever.
  const deleteItem = async () => {
    if (!draft?.id || acting.current) return;
    const id = draft.id;
    acting.current = true;
    try {
      const yes = await dialog.confirm("Delete this item? Bills already rung up are unaffected.", {
        title: "Delete item",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!yes) return;
      await showError(await authFetch(`/menu-items/${id}`, { method: "DELETE" }, approval));
      setDraft(null);
      loadMenu();
    } finally {
      acting.current = false;
    }
  };

  // The "86 it" switch — hide something that's run out without deleting it.
  // Hidden items vanish from the till's tiles but keep their price and photo,
  // ready to be switched back on tomorrow.
  const toggleAvailable = async (item: MenuItem) => {
    await showError(await authFetch(`/menu-items/${item.id}/available`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ available: !item.available }),
    }, approval));
    loadMenu();
  };

  const saveCategory = async (category: Category, changes: Partial<Category>) => {
    await showError(await authFetch(`/categories/${category.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // ⚠️ EVERY FIELD, EVERY TIME. The server REPLACES the category with what's
      //    in here rather than patching the bits that changed — and this one
      //    function is behind Rename, Admission, Move AND Send to bar. Drop a
      //    line from this object and that field silently resets to its default
      //    the next time anyone renames anything: leave `station` out and
      //    renaming "Drinks" marches every drink back onto the cook's board.
      body: JSON.stringify({
        name: changes.name ?? category.name,
        group: changes.group ?? category.group,
        station: changes.station ?? category.station,
        isAdmission: changes.isAdmission ?? category.isAdmission,
      }),
    }, approval));
    loadMenu();
  };

  const addCategory = async () => {
    if (!newCatName.trim() || !catFormGroup) return;
    const ok = await showError(await authFetch(`/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // New sections start at the kitchen — the board that's always staffed.
      // Send it to the bar afterwards if that's where it belongs.
      body: JSON.stringify({ name: newCatName.trim(), group: catFormGroup, station: "KITCHEN", isAdmission: false }),
    }, approval));
    if (!ok) return;
    setNewCatName("");
    setCatFormGroup(null);
    loadMenu();
  };

  // Remove a category. The server refuses if it still has items in it, so
  // there's no way to accidentally orphan half the menu.
  const deleteCategory = async (category: Category) => {
    if (acting.current) return;
    acting.current = true;
    try {
      const yes = await dialog.confirm(`Remove the category "${category.name}"?`, {
        title: "Remove category",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!yes) return;
      await showError(await authFetch(`/categories/${category.id}`, { method: "DELETE" }, approval));
      loadMenu();
    } finally {
      acting.current = false;
    }
  };

  // The house tax rate. Note what this does NOT do: it doesn't change anything
  // already priced. Existing items keep their own rate, and charges already on
  // bills keep the rate they were sold at. It only sets the starting point for
  // items created from now on — hence the wording of the confirmation.
  const saveDefaultTax = async () => {
    const rate = (parseFloat(defaultTaxPercent) || 0) / 100;
    const ok = await showError(await authFetch(`/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRate: rate }),
    }, approval));
    if (ok) await dialog.say("Saved. New items will start at this rate.", { title: "Default tax", tone: "info" });
  };

  // The cash discount. Unlike the tax rate above, this one DOES change what
  // guests pay from now on — it's read fresh at every checkout, so a change
  // here affects everyone still in the building.
  //
  // The server does the real checking, including the rule that the minimum
  // entry has to be larger than the discount. Whatever it refuses comes back as
  // a message through showError, so there's no second copy of that rule here.
  const saveCashDiscount = async () => {
    const amount = parseFloat(cashDiscount) || 0;
    const minEntry = parseFloat(cashDiscountMinEntry) || 0;
    const ok = await showError(await authFetch(`/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cashDiscount: amount, cashDiscountMinEntry: minEntry }),
    }, approval));
    if (!ok) return;
    setCashDiscount(amount.toFixed(2));
    setCashDiscountMinEntry(minEntry.toFixed(2));
    await dialog.say(
      amount > 0
        ? `Guests paying cash will get $${amount.toFixed(2)} off their entry, as long as their entry charge is $${minEntry.toFixed(2)} or more.`
        : "The cash discount is switched off. Nobody gets money off for paying cash.",
      { title: "Cash discount", tone: "info" }
    );
  };

  const q = query.trim().toLowerCase();
  const matches = (item: MenuItem) => !q || item.name.toLowerCase().includes(q);
  const itemCount = categories.reduce((n, c) => n + c.items.length, 0);
  const hiddenCount = categories.reduce((n, c) => n + c.items.filter((i) => !i.available).length, 0);
  const anyMatch = categories.some((c) => c.items.some(matches));

  // Which category the item being edited sits in — merchandise and services
  // get slightly different options in the panel, since they never involve the
  // kitchen.
  const draftCategory = draft ? categories.find((c) => String(c.id) === draft.categoryId) ?? null : null;
  const isMerch = draftCategory?.group === "MERCH_SERVICE";
  // A discount hides the price and tax boxes — it has neither of its own.
  const isDiscount = draft?.discountKind === "FIXED" || draft?.discountKind === "PERCENT";
  // A live "with tax, this comes to…" preview while typing a price.
  const draftPrice = parseFloat(draft?.price ?? "") || 0;
  const draftGross = draftPrice * (1 + (parseFloat(draft?.taxPercent ?? "") || 0) / 100);

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>Menu</div>
            <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
              {itemCount} item{itemCount === 1 ? "" : "s"} in {categories.length} categor{categories.length === 1 ? "y" : "ies"}
              {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
            </div>
          </div>
          <div style={{ background: "#efe7d9", padding: "5px 11px", borderRadius: 20 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: .5, color: "#7a6a53" }}>Admin editing</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {/* nowrap so a narrow window moves each control to its own line
              whole, rather than snapping the label off from its box. The outer
              row still wraps — it's only the insides that must stay together. */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flex: "none", whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#a89a86" }}>Default tax</span>
            <input
              className="mn-in"
              value={defaultTaxPercent}
              onChange={(e) => setDefaultTaxPercent(e.target.value)}
              style={{ width: 74, padding: "7px 10px" }}
            />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#a89a86" }}>%</span>
            <button onClick={saveDefaultTax} style={CHIP_BTN}>Save</button>
          </div>
          {/* The cash discount. Two numbers rather than one, because "$5 off"
              on its own would also take $5 off a $3 child admission. The
              minimum is what stops that, and the server refuses to save a
              minimum that isn't bigger than the discount. */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flex: "none", whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#a89a86" }}>Cash discount $</span>
            <input
              className="mn-in"
              value={cashDiscount}
              onChange={(e) => setCashDiscount(e.target.value)}
              style={{ width: 62, padding: "7px 10px" }}
            />
            <span style={{ fontSize: 12, fontWeight: 700, color: "#a89a86" }}>off entry over $</span>
            <input
              className="mn-in"
              value={cashDiscountMinEntry}
              onChange={(e) => setCashDiscountMinEntry(e.target.value)}
              style={{ width: 62, padding: "7px 10px" }}
            />
            <button onClick={saveCashDiscount} style={CHIP_BTN}>Save</button>
          </div>
          <button
            onClick={() => newItem()}
            style={{ padding: "10px 18px", border: "none", borderRadius: 11, background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, cursor: "pointer", boxShadow: "0 10px 22px -14px rgba(122,106,83,.9)" }}
          >
            + New item
          </button>
        </div>
      </div>

      <div style={{ padding: "20px 26px 28px", display: "grid", gridTemplateColumns: "1fr 348px", gap: 18, alignItems: "start" }}>
        {/* left: groups */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#fffdf9", border: "1.5px solid #d8cebc", borderRadius: 13, padding: "12px 16px" }}>
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" style={{ flex: "none" }}>
              <circle cx="7.5" cy="7.5" r="5.5" stroke="#a89a86" strokeWidth="2" />
              <line x1="11.6" y1="11.6" x2="16" y2="16" stroke="#a89a86" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input className="mn-search" placeholder="Search menu items" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div style={{ display: "flex", alignItems: "center", gap: 7, flex: "none" }}>
              <button onClick={() => setCollapsed({})} style={CHIP_BTN}>Expand all</button>
              <button
                onClick={() => {
                  const next: Record<number, boolean> = {};
                  categories.forEach((c) => { next[c.id] = true; });
                  setCollapsed(next);
                }}
                style={CHIP_BTN}
              >
                Collapse all
              </button>
            </div>
          </div>

          {GROUPS.map((group) => {
            const cats = categories.filter((c) => c.group === group.id);
            const count = cats.reduce((n, c) => n + c.items.length, 0);
            return (
              <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 3, background: group.dot }} />
                    <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: "#6b6152" }}>
                      {group.label}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: "#b8ab97" }}>{count} items</div>
                  </div>
                  <div
                    onClick={() => { setCatFormGroup(group.id); setDraft(null); setNewCatName(""); }}
                    style={{ fontSize: 12, fontWeight: 800, color: "#7a6a53", cursor: "pointer" }}
                  >
                    + Category
                  </div>
                </div>

                {cats.map((category) => {
                  const open = !collapsed[category.id];
                  const shown = category.items.filter(matches);
                  const prices = category.items.map((i) => i.price);
                  const range = prices.length
                    ? `${money(Math.min(...prices))} – ${money(Math.max(...prices))}`
                    : "";
                  return (
                    <div key={category.id} style={{ ...PANEL, overflow: "hidden" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: open ? "1px solid rgba(43,38,32,.07)" : "none", background: open ? "#fffdf9" : "#faf7f0" }}>
                        <div
                          onClick={() => setCollapsed((p) => ({ ...p, [category.id]: open }))}
                          style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: "pointer", flex: 1 }}
                        >
                          <div style={{ width: 18, flex: "none", color: "#7a6a53", fontSize: 11, fontWeight: 800, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>
                            ▶
                          </div>
                          <div style={{ fontSize: 14.5, fontWeight: 800 }}>{category.name}</div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#b8ab97" }}>{category.items.length} items</div>
                          {category.isAdmission && (
                            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: .5, textTransform: "uppercase", color: "#7a6a53", background: "#efe7d9", borderRadius: 20, padding: "3px 9px" }}>
                              Admission
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
                          {/* WHICH BOARD this section's tickets print on. Shown
                              as a badge as well as a button, deliberately: the
                              button beside it names the ACTION ("Send to Bar"),
                              so on its own you'd have to read it backwards to
                              work out where the drinks currently go. This says
                              it outright. Merchandise has no board, so no badge.

                              It lives in this right-hand group rather than up
                              beside the category name because that left group
                              stretches and its contents don't shrink — a fourth
                              thing in there pushed straight through the price
                              range and sat on top of it. */}
                          {group.id === "FOOD_DRINK" && (
                            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: .5, textTransform: "uppercase", color: "#7a6a53", background: "#efe7d9", borderRadius: 20, padding: "3px 9px" }}>
                              {category.station === "BAR" ? "Bar" : "Kitchen"}
                            </div>
                          )}
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#b8ab97" }}>{range}</div>
                          <button onClick={() => newItem(category.id)} style={CHIP_BTN}>+ Item</button>
                          <button
                            onClick={async () => {
                              if (acting.current) return;
                              acting.current = true;
                              try {
                                // null means they cancelled; "" means they
                                // cleared the box and pressed Save, which is
                                // not a name a category can have.
                                const name = await dialog.askText("Category name", {
                                  title: "Rename category",
                                  initial: category.name,
                                });
                                if (!name?.trim() || name === category.name) return;
                                await saveCategory(category, { name: name.trim() });
                              } finally {
                                acting.current = false;
                              }
                            }}
                            style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                          >
                            Rename
                          </button>
                          {/* Marking a category "Admission" changes how the
                              till behaves: its tiles swap the guest's entry
                              charge instead of adding to the tab. Food can
                              never be an admission, so this is only offered
                              on the merchandise side. */}
                          {group.id === "MERCH_SERVICE" && (
                            <button
                              onClick={() => saveCategory(category, { isAdmission: !category.isAdmission })}
                              style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                            >
                              {category.isAdmission ? "Not admission" : "Admission"}
                            </button>
                          )}
                          {/* Which board this section's tickets go to. Only
                              Food & drinks has a board at all — a towel reaches
                              neither, so offering the switch there would be a
                              control that does nothing.

                              Tickets ALREADY on a board don't move. A tea being
                              brewed stays on the cook's screen; the next tea
                              goes to the bar. */}
                          {group.id === "FOOD_DRINK" && (
                            <button
                              onClick={() => saveCategory(category, { station: category.station === "BAR" ? "KITCHEN" : "BAR" })}
                              style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                            >
                              {category.station === "BAR" ? "Send to Kitchen" : "Send to Bar"}
                            </button>
                          )}
                          {/* "Move" swaps a category between the two halves.
                              It's more than cosmetic: moving something into
                              Food & drinks makes it start printing tickets, and
                              moving it out stops that. A section moved back in
                              lands at the kitchen, whatever it was before. */}
                          <button
                            onClick={() => saveCategory(category, { group: group.id === "FOOD_DRINK" ? "MERCH_SERVICE" : "FOOD_DRINK" })}
                            style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                          >
                            Move
                          </button>
                          <button
                            onClick={() => deleteCategory(category)}
                            style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      {open && shown.map((item) => (
                        <div
                          key={item.id}
                          className="mn-row"
                          onClick={() => editItem(item)}
                          style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 18px", borderBottom: "1px solid rgba(43,38,32,.05)", cursor: "pointer", opacity: item.available ? 1 : .6 }}
                        >
                          <div style={{ width: 46, height: 46, flex: "none", borderRadius: 10, overflow: "hidden", background: "repeating-linear-gradient(45deg,#efe7d9,#efe7d9 5px,#e7dcc9 5px,#e7dcc9 10px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            {item.imageData ? (
                              <img src={item.imageData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                              <span style={{ fontSize: 8, fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "#a89a86", textAlign: "center", lineHeight: 1.2 }}>
                                no<br />photo
                              </span>
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.2 }}>{item.name}</div>
                            <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
                              {/* A discount has no price to show — what matters
                                  is how much it takes off, so say that instead. */}
                              {item.discountKind
                                ? item.discountKind === "PERCENT"
                                  ? `Discount · ${item.discountValue}% off the tab`
                                  : `Discount · ${money(item.discountValue)} off`
                                : `Tax ${(item.taxRate * 100).toFixed(2)}% · ${money(item.price * (1 + item.taxRate))} with tax`}
                              {/* Only meaningful on food and drink — a towel that
                                  doesn't go to the kitchen isn't worth remarking on. */}
                              {category.group === "FOOD_DRINK" && !item.sendsToKitchen ? " · self-serve" : ""}
                              {item.visitCredits > 0 ? ` · grants ${item.visitCredits} visits` : ""}
                              {item.redeemsPass ? " · redeems a pass" : ""}
                            </div>
                          </div>
                          <div style={{ flex: "none", fontSize: 15, fontWeight: 800, width: 74, textAlign: "right" }}>
                            {money(item.price)}
                          </div>
                          {/* The On sale / Hidden switch. stopPropagation is
                              needed because this sits inside a row that opens
                              the editor when clicked — without it, toggling
                              would also open the panel. */}
                          <div
                            onClick={(e) => { e.stopPropagation(); toggleAvailable(item); }}
                            style={{ flex: "none", width: 80, textAlign: "center", fontSize: 10, fontWeight: 800, letterSpacing: .5, textTransform: "uppercase", color: item.available ? "#3f5540" : "#8f3f28", background: item.available ? "#dfeada" : "#f7e4dc", borderRadius: 20, padding: "4px 0", cursor: "pointer" }}
                          >
                            {item.available ? "On sale" : "Hidden"}
                          </div>
                        </div>
                      ))}

                      {open && shown.length === 0 && (
                        <div style={{ padding: 18, textAlign: "center", fontSize: 13, fontWeight: 600, color: "#b8ab97" }}>
                          {q ? "Nothing here matches your search." : "No items in this category yet."}
                        </div>
                      )}
                    </div>
                  );
                })}

                {cats.length === 0 && (
                  <div style={{ padding: 20, textAlign: "center", fontSize: 13, fontWeight: 600, color: "#b8ab97", background: "#fffdf9", border: "1px dashed #d8cebc", borderRadius: 14 }}>
                    No categories in this group yet.
                  </div>
                )}
              </div>
            );
          })}

          {q !== "" && !anyMatch && (
            <div style={{ padding: 30, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86", background: "#fffdf9", border: "1px dashed #d8cebc", borderRadius: 16 }}>
              Nothing matches “{query}”.
            </div>
          )}
        </div>

        {/* right: editor */}
        <div style={{ ...PANEL, borderRadius: 18, position: "sticky", top: 20, overflow: "hidden" }}>
          <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
            <div style={{ ...LABEL, marginBottom: 0 }}>
              {draft ? (draft.id ? "Editing item" : "New item") : catFormGroup ? "New category" : "Editor"}
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 3 }}>
              {draft ? (draft.name || "Untitled item") : catFormGroup ? GROUPS.find((g) => g.id === catFormGroup)?.label : "Nothing selected"}
            </div>
          </div>

          {!draft && !catFormGroup && (
            <div style={{ padding: "26px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
                Pick any item on the left to edit its name, photo, price, tax rate or category — or start a new one.
              </div>
              <button
                onClick={() => newItem()}
                style={{ padding: 13, borderRadius: 12, border: "none", background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer" }}
              >
                + New item
              </button>
            </div>
          )}

          {catFormGroup && (
            <div style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={LABEL}>Name</div>
                <input className="mn-in" placeholder="e.g. Breakfast" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
                {catFormGroup === "FOOD_DRINK"
                  ? "Items here print a ticket in the kitchen when they're ordered."
                  : "Items here don't reach the kitchen — services, retail, passes and admissions."}
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setCatFormGroup(null)} style={{ ...CHIP_BTN, padding: "12px 16px", fontSize: 13.5, color: "#6b6152" }}>Cancel</button>
                <button
                  onClick={addCategory}
                  style={{ flex: 1, padding: 12, borderRadius: 12, border: "none", background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}
                >
                  Add category
                </button>
              </div>
            </div>
          )}

          {draft && (
            <div style={{ padding: "18px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={LABEL}>Photo</div>
                <label style={{ display: "flex", alignItems: "center", gap: 14, border: "1.5px dashed #d8cebc", borderRadius: 13, padding: 12, cursor: "pointer", background: "#fffdf9" }}>
                  <div style={{ width: 64, height: 64, flex: "none", borderRadius: 10, overflow: "hidden", background: "repeating-linear-gradient(45deg,#efe7d9,#efe7d9 6px,#e7dcc9 6px,#e7dcc9 12px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {draft.imageData ? (
                      <img src={draft.imageData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <span style={{ fontSize: 8.5, fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "#a89a86" }}>item shot</span>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#5f5340" }}>Upload image</div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "#b8ab97", marginTop: 2 }}>
                      JPG or PNG, square crops look best
                    </div>
                  </div>
                  <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
                </label>
                {draft.imageData && (
                  <div
                    onClick={() => setDraft({ ...draft, imageData: null })}
                    style={{ fontSize: 11.5, fontWeight: 700, color: "#a89a86", marginTop: 7, cursor: "pointer" }}
                  >
                    Remove photo
                  </div>
                )}
              </div>

              <div>
                <div style={LABEL}>Item name</div>
                <input className="mn-in" placeholder="e.g. Miso Poké Bowl" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>

              {/* A discount has no price and no tax rate of its own — it takes
                  a share off whatever is already on the tab, and carries that
                  tab's blended tax rate so the tax falls with it. Showing empty
                  Price and Tax boxes would just invite someone to fill them in
                  and wonder why nothing happened. */}
              {!isDiscount && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <div style={LABEL}>Price</div>
                    <input className="mn-in" placeholder="0.00" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
                  </div>
                  <div>
                    <div style={LABEL}>Tax rate %</div>
                    <input className="mn-in" placeholder="13.00" value={draft.taxPercent} onChange={(e) => setDraft({ ...draft, taxPercent: e.target.value })} />
                  </div>
                </div>
              )}

              {/* ---- Is this a discount? ---- */}
              <div style={{ background: "#f7f3ea", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 11 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>This item is a discount</div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>
                      Takes money off a tab instead of adding to it. Needs a manager's approval to use.
                    </div>
                  </div>
                  <div
                    onClick={() => setDraft({ ...draft, discountKind: isDiscount ? "" : "PERCENT", discountValue: isDiscount ? "" : draft.discountValue })}
                    style={{ width: 46, height: 26, flex: "none", borderRadius: 20, background: isDiscount ? "#5f7a5a" : "#d8cebc", position: "relative", cursor: "pointer", transition: "background .15s" }}
                  >
                    <div style={{ position: "absolute", top: 3, left: isDiscount ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fffdf9", transition: "left .15s" }} />
                  </div>
                </div>

                {isDiscount && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
                    <div>
                      <div style={LABEL}>How it's worked out</div>
                      <div style={{ display: "inline-flex", background: "#e7e0d5", borderRadius: 11, padding: 3, gap: 3 }}>
                        {([["PERCENT", "Percent off"], ["FIXED", "Amount off"]] as const).map(([id, label]) => {
                          const on = draft.discountKind === id;
                          return (
                            <div
                              key={id}
                              onClick={() => setDraft({ ...draft, discountKind: id })}
                              style={{ padding: "7px 13px", borderRadius: 9, cursor: "pointer", fontSize: 12.5, fontWeight: 700, background: on ? "#fffdf9" : "transparent", color: on ? "#2b2620" : "#8a7d6a", boxShadow: on ? "0 1px 3px rgba(43,38,32,.12)" : "none" }}
                            >
                              {label}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div>
                      <div style={LABEL}>{draft.discountKind === "PERCENT" ? "Percent off the tab" : "Dollars off"}</div>
                      <input
                        className="mn-in"
                        placeholder={draft.discountKind === "PERCENT" ? "20" : "5.00"}
                        value={draft.discountValue}
                        onChange={(e) => setDraft({ ...draft, discountValue: e.target.value })}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div>
                <div style={LABEL}>Category</div>
                <select className="mn-in" value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
                  {GROUPS.map((g) => (
                    <optgroup key={g.id} label={g.label}>
                      {categories.filter((c) => c.group === g.id).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <div style={LABEL}>Description (optional)</div>
                <input className="mn-in" placeholder="Shown as a tooltip at the till" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f7f3ea", borderRadius: 12, padding: "12px 14px" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800 }}>Available in Point of Sale</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>Hidden items stay on the menu but can't be sold</div>
                </div>
                <div
                  onClick={() => setDraft({ ...draft, available: !draft.available })}
                  style={{ width: 46, height: 26, flex: "none", borderRadius: 20, background: draft.available ? "#5f7a5a" : "#d8cebc", position: "relative", cursor: "pointer", transition: "background .15s" }}
                >
                  <div style={{ position: "absolute", top: 3, left: draft.available ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fffdf9", transition: "left .15s" }} />
                </div>
              </div>

              {/* Only shown for food and drink. Merchandise and services never
                  send tickets anyway, so the switch would do nothing there —
                  and offering a control that has no effect is worse than not
                  offering one. Same `isMerch` that gates the Advanced block. */}
              {!isMerch && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f7f3ea", borderRadius: 12, padding: "12px 14px" }}>
                  <div>
                    {/* Names the board this item's section actually goes to,
                        rather than always saying "kitchen" — on a Drinks
                        section that would be plain wrong. The switch itself is
                        unchanged: it can only ever turn a ticket OFF. */}
                    <div style={{ fontSize: 13, fontWeight: 800 }}>
                      Sends a ticket to the {draftCategory?.station === "BAR" ? "bar" : "kitchen"}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>
                      Switch off for anything handed straight over — bottled drinks, packaged snacks
                    </div>
                  </div>
                  <div
                    onClick={() => setDraft({ ...draft, sendsToKitchen: !draft.sendsToKitchen })}
                    style={{ width: 46, height: 26, flex: "none", borderRadius: 20, background: draft.sendsToKitchen ? "#5f7a5a" : "#d8cebc", position: "relative", cursor: "pointer", transition: "background .15s" }}
                  >
                    <div style={{ position: "absolute", top: 3, left: draft.sendsToKitchen ? 23 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fffdf9", transition: "left .15s" }} />
                  </div>
                </div>
              )}

              {/* THE VISIT PASS CONTROLS. These two settings are opposites and
                  are the easiest thing in the app to confuse:

                    "Visit passes granted when sold" — buying this ADDS passes
                    to the guest's balance. A 10-visit pack sets this to 10.

                    "This admission redeems a visit pass" — choosing this
                    SPENDS one of their passes instead of charging money.

                  One is the pack you buy, the other is the entry you get with
                  it. Never set both on the same item. Only shown for
                  merchandise and services, since food never involves passes. */}
              {isMerch && (
                <div style={{ border: "1px solid rgba(43,38,32,.08)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ ...LABEL, marginBottom: 0 }}>Advanced</div>
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 700 }}>Visit passes granted when sold</div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86", marginBottom: 6 }}>
                      Set to 10 for a 10-visit pack. Leave at 0 for anything else.
                    </div>
                    <input className="mn-in" value={draft.visitCredits} onChange={(e) => setDraft({ ...draft, visitCredits: e.target.value })} style={{ width: 90 }} />
                  </div>
                  {draftCategory?.isAdmission && (
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={draft.redeemsPass}
                        onChange={(e) => setDraft({ ...draft, redeemsPass: e.target.checked })}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <span style={{ fontSize: 12.5, fontWeight: 700 }}>This admission redeems a visit pass</span>
                        <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>
                          Applied automatically at check-in when the guest has credit left.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              )}

              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700, color: "#6b6152", padding: "0 2px" }}>
                <span>Guest pays with tax</span>
                <span style={{ fontWeight: 800, color: "#2b2620" }}>{money(draftGross)}</span>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setDraft(null)} style={{ ...CHIP_BTN, padding: "13px 16px", fontSize: 13.5, color: "#6b6152" }}>Cancel</button>
                <button
                  onClick={saveItem}
                  style={{ flex: 1, padding: 13, borderRadius: 12, border: "none", background: "#7a6a53", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer" }}
                >
                  {draft.id ? "Save changes" : "Add item"}
                </button>
              </div>
              {draft.id && (
                <div onClick={deleteItem} style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "#8f3f28", cursor: "pointer" }}>
                  Delete this item
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MenuPage;