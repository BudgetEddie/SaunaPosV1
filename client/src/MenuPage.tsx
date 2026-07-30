import { useEffect, useState, type FormEvent } from "react";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";

const socket = io("http://localhost:4000");

type MenuItem = {
  id: number;
  categoryId: number;
  name: string;
  price: number;
  description: string | null;
  visitCredits: number;
  redeemsPass: boolean;
};
type Category = { id: number; name: string; isKitchen: boolean; isAdmission: boolean; items: MenuItem[] };

function MenuPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [taxRate, setTaxRate] = useState(0.13);
  const [defaultAdmissionItemId, setDefaultAdmissionItemId] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryKitchen, setNewCategoryKitchen] = useState(false);
  const [newCategoryAdmission, setNewCategoryAdmission] = useState(false);
  const [taxPercent, setTaxPercent] = useState("13.00");
  const [defaultAdmission, setDefaultAdmission] = useState("");
  const [itemCategoryId, setItemCategoryId] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemVisitCredits, setItemVisitCredits] = useState("");
  const [itemRedeemsPass, setItemRedeemsPass] = useState(false);

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const loadMenu = () => {
    authFetch(`/categories`).then((r) => r.json()).then(setCategories);
  };
  const loadSettings = () => {
    authFetch(`/settings`).then((r) => r.json()).then((s) => {
      setTaxRate(s.taxRate);
      setDefaultAdmissionItemId(s.defaultAdmissionItemId);
      if (!loaded) {
        setTaxPercent((s.taxRate * 100).toFixed(2));
        setDefaultAdmission(s.defaultAdmissionItemId ? String(s.defaultAdmissionItemId) : "");
        setLoaded(true);
      }
    });
  };

  useEffect(() => {
    if (!isAdmin) return;
    loadMenu();
    loadSettings();
    socket.on("menu:updated", loadMenu);
    return () => {
      socket.off("menu:updated", loadMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAdmin) {
    return (
      <div style={{ padding: "18px 26px" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>Menu</h1>
        <p>Only the admin login can edit the menu.</p>
      </div>
    );
  }

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
  };

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCategoryName) return;
    await showError(await authFetch(`/categories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newCategoryName,
        isKitchen: newCategoryKitchen,
        isAdmission: newCategoryAdmission,
      }),
    }));
    setNewCategoryName("");
    setNewCategoryKitchen(false);
    setNewCategoryAdmission(false);
  };

  const updateCategory = async (c: Category, changes: Partial<Category>) => {
    await showError(await authFetch(`/categories/${c.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: changes.name ?? c.name,
        isKitchen: changes.isKitchen ?? c.isKitchen,
        isAdmission: changes.isAdmission ?? c.isAdmission,
      }),
    }));
  };

  const renameCategory = async (c: Category) => {
    const name = prompt("New category name:", c.name);
    if (!name || name === c.name) return;
    await updateCategory(c, { name });
  };

  const deleteCategory = async (id: number) => {
    if (!confirm("Delete this category?")) return;
    await showError(await authFetch(`/categories/${id}`, { method: "DELETE" }));
  };

  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!itemCategoryId || !itemName || !itemPrice) return;
    await showError(await authFetch(`/menu-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId: Number(itemCategoryId),
        name: itemName,
        price: parseFloat(itemPrice),
        description: itemDescription || null,
        visitCredits: itemVisitCredits ? parseInt(itemVisitCredits, 10) : 0,
        redeemsPass: itemRedeemsPass,
      }),
    }));
    setItemName("");
    setItemPrice("");
    setItemDescription("");
    setItemVisitCredits("");
    setItemRedeemsPass(false);
  };

  const editItem = async (item: MenuItem) => {
    const name = prompt("Item name:", item.name);
    if (name === null) return;
    const priceStr = prompt("Price:", String(item.price));
    if (priceStr === null) return;
    const description = prompt("Description (optional):", item.description ?? "");
    if (description === null) return;
    const creditsStr = prompt("Visit credits granted when sold (0 for a normal item):", String(item.visitCredits));
    if (creditsStr === null) return;
    const redeemsStr = prompt("Does this admission redeem a visit pass? (yes/no)", item.redeemsPass ? "yes" : "no");
    if (redeemsStr === null) return;
    await showError(await authFetch(`/menu-items/${item.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryId: item.categoryId,
        name: name || item.name,
        price: parseFloat(priceStr) || item.price,
        description: description || null,
        visitCredits: parseInt(creditsStr, 10) || 0,
        redeemsPass: redeemsStr.trim().toLowerCase().startsWith("y"),
      }),
    }));
  };

  const deleteItem = async (id: number) => {
    if (!confirm("Delete this item? Existing bills are unaffected.")) return;
    await showError(await authFetch(`/menu-items/${id}`, { method: "DELETE" }));
  };

  const saveTax = async () => {
    const rate = parseFloat(taxPercent) / 100;
    await showError(await authFetch(`/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRate: rate }),
    }));
    alert("Tax rate saved. Applies to new check-ins; existing bills keep their rate.");
  };

  const saveDefaultAdmission = async () => {
    await showError(await authFetch(`/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAdmissionItemId: defaultAdmission ? Number(defaultAdmission) : null }),
    }));
    alert("Default admission saved. Applies to new check-ins.");
  };

  const admissionItems = categories.filter((c) => c.isAdmission).flatMap((c) => c.items);

  return (
    <div style={{ padding: "18px 26px 30px", maxWidth: 760 }}>
      <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 800 }}>Menu</h1>
      <p style={{ color: "#8a7f6d", marginTop: 0 }}>
        Current tax rate: {(taxRate * 100).toFixed(2)}%
        {defaultAdmissionItemId ? "" : " · no default admission set"}
      </p>

      <h3>Tax rate</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="number" step="0.01" value={taxPercent} onChange={(e) => setTaxPercent(e.target.value)} style={{ width: 90 }} /> %
        <button onClick={saveTax}>Save tax rate</button>
      </div>

      <h3>Default admission</h3>
      <p style={{ color: "#666", margin: "4px 0" }}>
        Billed automatically at check-in. Staff can override it per visit. Pick a paying admission here, not the pass one.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select value={defaultAdmission} onChange={(e) => setDefaultAdmission(e.target.value)}>
          <option value="">No automatic admission charge</option>
          {admissionItems.map((i) => (
            <option key={i.id} value={i.id}>{i.name} — ${i.price.toFixed(2)}</option>
          ))}
        </select>
        <button onClick={saveDefaultAdmission}>Save default</button>
      </div>

      <h3>Categories</h3>
      <form onSubmit={addCategory} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder="New category name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
        <label>
          <input type="checkbox" checked={newCategoryKitchen} onChange={(e) => setNewCategoryKitchen(e.target.checked)} /> kitchen
        </label>
        <label>
          <input type="checkbox" checked={newCategoryAdmission} onChange={(e) => setNewCategoryAdmission(e.target.checked)} /> admission
        </label>
        <button type="submit">Add category</button>
      </form>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {categories.map((c) => (
          <li key={c.id} style={{ padding: 6, borderBottom: "1px solid #ddd" }}>
            <strong>{c.name}</strong> ({c.items.length} items)
            {c.isKitchen ? " · kitchen" : ""}
            {c.isAdmission ? " · admission" : ""}{" "}
            <button onClick={() => updateCategory(c, { isKitchen: !c.isKitchen })}>
              {c.isKitchen ? "Unset kitchen" : "Set kitchen"}
            </button>{" "}
            <button onClick={() => updateCategory(c, { isAdmission: !c.isAdmission })}>
              {c.isAdmission ? "Unset admission" : "Set admission"}
            </button>{" "}
            <button onClick={() => renameCategory(c)}>Rename</button>{" "}
            <button onClick={() => deleteCategory(c.id)}>Delete</button>
            <ul>
              {c.items.map((item) => (
                <li key={item.id}>
                  {item.name} — ${item.price.toFixed(2)}
                  {item.description ? ` · ${item.description}` : ""}
                  {item.visitCredits > 0 ? ` · grants ${item.visitCredits} visits` : ""}
                  {item.redeemsPass ? " · redeems a pass" : ""}{" "}
                  <button onClick={() => editItem(item)}>Edit</button>{" "}
                  <button onClick={() => deleteItem(item.id)}>Delete</button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <h3>Add item</h3>
      <form onSubmit={addItem} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
        <select value={itemCategoryId} onChange={(e) => setItemCategoryId(e.target.value)}>
          <option value="">Select category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input placeholder="Item name" value={itemName} onChange={(e) => setItemName(e.target.value)} />
        <input placeholder="Price" type="number" step="0.01" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} />
        <input placeholder="Description (optional)" value={itemDescription} onChange={(e) => setItemDescription(e.target.value)} />
        <input placeholder="Visit credits granted when sold (e.g. 10)" type="number" value={itemVisitCredits} onChange={(e) => setItemVisitCredits(e.target.value)} />
        <label>
          <input type="checkbox" checked={itemRedeemsPass} onChange={(e) => setItemRedeemsPass(e.target.checked)} /> this admission redeems a visit pass
        </label>
        <button type="submit">Add item</button>
      </form>
    </div>
  );
}

export default MenuPage;