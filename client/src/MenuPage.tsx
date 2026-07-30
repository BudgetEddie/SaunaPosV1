import { useEffect, useState, type ChangeEvent } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import { type Category, type MenuItem } from "./types.ts";

const socket = io("http://localhost:4000");

const GROUPS = [
  { id: "FOOD_DRINK", label: "Food & drinks", dot: "#7a6a53" },
  { id: "MERCH_SERVICE", label: "Merchandise & services", dot: "#a89a86" },
];

type Draft = {
  id: number | null;
  categoryId: string;
  name: string;
  price: string;
  taxPercent: string;
  description: string;
  imageData: string | null;
  available: boolean;
  visitCredits: string;
  redeemsPass: boolean;
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
  return `$${n.toFixed(2)}`;
}
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
    visitCredits: "0",
    redeemsPass: false,
  };
}

function MenuPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [defaultTaxPercent, setDefaultTaxPercent] = useState("13.00");
  const [loadedSettings, setLoadedSettings] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catFormGroup, setCatFormGroup] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);

  useEffect(() => {
    if (!isAdmin) return;
    loadMenu();
    authFetch(`/settings`).then((r) => r.json()).then((s) => {
      if (!loadedSettings) {
        setDefaultTaxPercent((s.taxRate * 100).toFixed(2));
        setLoadedSettings(true);
      }
    });
    socket.on("menu:updated", loadMenu);
    return () => {
      socket.off("menu:updated", loadMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAdmin) {
    return (
      <div style={{ background: "#f4efe7", minHeight: "100vh", padding: 26 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Menu</h1>
        <p style={{ color: "#a89a86", fontWeight: 600 }}>Only the admin login can edit the menu.</p>
      </div>
    );
  }

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
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
      visitCredits: String(item.visitCredits),
      redeemsPass: item.redeemsPass,
    });
  };

  const newItem = (categoryId?: number) => {
    const target = categoryId ?? categories[0]?.id;
    if (!target) {
      alert("Add a category first.");
      return;
    }
    setCatFormGroup(null);
    setCollapsed((prev) => ({ ...prev, [target]: false }));
    setDraft(blankDraft(target, defaultTaxPercent));
  };

  // Shrink the picture in the browser before it ever reaches the server: a 4MB
  // phone photo becomes roughly 40KB, which is small enough to keep in the
  // database alongside the item.
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
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
      alert("Give the item a name.");
      return;
    }
    const price = parseFloat(draft.price);
    if (Number.isNaN(price)) {
      alert("Give the item a price.");
      return;
    }
    const body = {
      categoryId: Number(draft.categoryId),
      name: draft.name.trim(),
      price,
      description: draft.description.trim() || null,
      taxRate: (parseFloat(draft.taxPercent) || 0) / 100,
      imageData: draft.imageData,
      available: draft.available,
      visitCredits: parseInt(draft.visitCredits, 10) || 0,
      redeemsPass: draft.redeemsPass,
    };
    const res = draft.id
      ? await authFetch(`/menu-items/${draft.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      : await authFetch(`/menu-items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    if (!(await showError(res))) return;
    setDraft(null);
    loadMenu();
  };

  const deleteItem = async () => {
    if (!draft?.id) return;
    if (!confirm("Delete this item? Bills already rung up are unaffected.")) return;
    await showError(await authFetch(`/menu-items/${draft.id}`, { method: "DELETE" }));
    setDraft(null);
    loadMenu();
  };

  const toggleAvailable = async (item: MenuItem) => {
    await showError(await authFetch(`/menu-items/${item.id}/available`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ available: !item.available }),
    }));
    loadMenu();
  };

  const saveCategory = async (category: Category, changes: Partial<Category>) => {
    await showError(await authFetch(`/categories/${category.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: changes.name ?? category.name,
        group: changes.group ?? category.group,
        isAdmission: changes.isAdmission ?? category.isAdmission,
      }),
    }));
    loadMenu();
  };

  const addCategory = async () => {
    if (!newCatName.trim() || !catFormGroup) return;
    const ok = await showError(await authFetch(`/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCatName.trim(), group: catFormGroup, isAdmission: false }),
    }));
    if (!ok) return;
    setNewCatName("");
    setCatFormGroup(null);
    loadMenu();
  };

  const deleteCategory = async (category: Category) => {
    if (!confirm(`Remove the category "${category.name}"?`)) return;
    await showError(await authFetch(`/categories/${category.id}`, { method: "DELETE" }));
    loadMenu();
  };

  const saveDefaultTax = async () => {
    const rate = (parseFloat(defaultTaxPercent) || 0) / 100;
    const ok = await showError(await authFetch(`/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRate: rate }),
    }));
    if (ok) alert("Saved. New items will start at this rate.");
  };

  const q = query.trim().toLowerCase();
  const matches = (item: MenuItem) => !q || item.name.toLowerCase().includes(q);
  const itemCount = categories.reduce((n, c) => n + c.items.length, 0);
  const hiddenCount = categories.reduce((n, c) => n + c.items.filter((i) => !i.available).length, 0);
  const anyMatch = categories.some((c) => c.items.some(matches));

  const draftCategory = draft ? categories.find((c) => String(c.id) === draft.categoryId) ?? null : null;
  const isMerch = draftCategory?.group === "MERCH_SERVICE";
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
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
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
                          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#b8ab97" }}>{range}</div>
                          <button onClick={() => newItem(category.id)} style={CHIP_BTN}>+ Item</button>
                          <button
                            onClick={() => {
                              const name = prompt("Category name:", category.name);
                              if (name && name !== category.name) saveCategory(category, { name });
                            }}
                            style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                          >
                            Rename
                          </button>
                          {group.id === "MERCH_SERVICE" && (
                            <button
                              onClick={() => saveCategory(category, { isAdmission: !category.isAdmission })}
                              style={{ ...CHIP_BTN, border: "none", background: "transparent", color: "#a89a86" }}
                            >
                              {category.isAdmission ? "Not admission" : "Admission"}
                            </button>
                          )}
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
                              Tax {(item.taxRate * 100).toFixed(2)}% · {money(item.price * (1 + item.taxRate))} with tax
                              {item.visitCredits > 0 ? ` · grants ${item.visitCredits} visits` : ""}
                              {item.redeemsPass ? " · redeems a pass" : ""}
                            </div>
                          </div>
                          <div style={{ flex: "none", fontSize: 15, fontWeight: 800, width: 74, textAlign: "right" }}>
                            {money(item.price)}
                          </div>
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