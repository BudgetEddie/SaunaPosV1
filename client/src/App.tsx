import { useEffect, useState, type FormEvent } from "react";
import { io } from "socket.io-client";
import { groupItems } from "./groupItems.ts";

const socket = io("http://localhost:4000");
const API = "http://localhost:4000";

type Customer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  phone: string | null;
  email: string | null;
  visitPassBalance: number;
};

type Locker = { id: number; number: string; gender: string; status: string };

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

type BillLineItem = { id: number; description: string; amount: number; isAdmission: boolean };
type Bill = { id: number; taxRate: number; lineItems: BillLineItem[] };

type Order = { id: number; status: string; items: { id: number; name: string }[] };
type Visit = {
  id: number;
  customer: Customer;
  locker: Locker;
  bill: Bill;
  orders: Order[];
  redeemsPass: boolean;
};

function billTotal(bill: Bill) {
  const subtotal = bill.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = subtotal * bill.taxRate;
  return { subtotal, tax, total: subtotal + tax };
}

function LockerPicker({ lockers, value, onChange }: { lockers: Locker[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select locker…</option>
      {lockers.map((l) => (
        <option key={l.id} value={l.id}>{l.number}</option>
      ))}
    </select>
  );
}

function MenuPicker({ categories, onPick }: { categories: Category[]; onPick: (item: MenuItem) => void }) {
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const active = categories.find((c) => c.id === activeCategoryId);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveCategoryId(c.id === activeCategoryId ? null : c.id)}
            style={{ fontWeight: c.id === activeCategoryId ? "bold" : "normal" }}
          >
            {c.name}
          </button>
        ))}
      </div>
      {active && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {active.items.map((item) => (
            <button key={item.id} onClick={() => onPick(item)} title={item.description ?? ""}>
              {item.name} — ${item.price.toFixed(2)}
            </button>
          ))}
          {active.items.length === 0 && <em>No items in this category yet.</em>}
        </div>
      )}
    </div>
  );
}

function ActiveVisitRow({ visit, lockers, categories, onChanged }: {
  visit: Visit;
  lockers: Locker[];
  categories: Category[];
  onChanged: () => void;
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [newLockerId, setNewLockerId] = useState("");
  const { subtotal, tax, total } = billTotal(visit.bill);

  const availableForCustomer = lockers.filter(
    (l) => l.gender === visit.customer.gender && l.status === "AVAILABLE"
  );

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
  };

  const addLineItem = async (desc: string, amt: number) => {
    await fetch(`${API}/bills/${visit.bill.id}/line-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: desc, amount: amt }),
    });
  };

  const pickItem = async (item: MenuItem) => {
    const category = categories.find((c) => c.id === item.categoryId);

    if (item.visitCredits > 0) {
      // Selling a pass pack wins over everything, whatever category it lives in
      await fetch(`${API}/visits/${visit.id}/purchase-pass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name, amount: item.price, visitCredits: item.visitCredits }),
      });
    } else if (category?.isAdmission) {
      await showError(await fetch(`${API}/visits/${visit.id}/set-admission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: item.id }),
      }));
    } else if (category?.isKitchen) {
      await fetch(`${API}/visits/${visit.id}/order-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name, amount: item.price }),
      });
    } else {
      await addLineItem(item.name, item.price);
    }
    onChanged();
  };

  const addCustomCharge = async (e: FormEvent) => {
    e.preventDefault();
    if (!description || !amount) return;
    await addLineItem(description, parseFloat(amount));
    setDescription("");
    setAmount("");
  };

  const changeLocker = async () => {
    if (!newLockerId) return;
    await showError(await fetch(`${API}/visits/${visit.id}/change-locker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockerId: Number(newLockerId) }),
    }));
    setNewLockerId("");
    onChanged();
  };

  const checkOut = async () => {
    await showError(await fetch(`${API}/check-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitId: visit.id, paymentMethod }),
    }));
    onChanged();
  };

  const openOrders = visit.orders.filter((o) => o.status !== "COMPLETE");

  return (
    <li style={{ padding: 12, borderBottom: "1px solid #ddd" }}>
      <strong>{visit.customer.firstName} {visit.customer.lastName}</strong> — locker {visit.locker.number}
      {" — "}
      <span style={{ color: "#666" }}>
        {visit.customer.visitPassBalance} pass{visit.customer.visitPassBalance === 1 ? "" : "es"} left
      </span>
      {visit.redeemsPass && <strong style={{ color: "#0a7" }}> · on a pass</strong>}

      <ul>
        {visit.bill.lineItems.map((item) => (
          <li key={item.id}>
            {item.description} — ${item.amount.toFixed(2)}
            {item.isAdmission ? <em style={{ color: "#666" }}> (admission)</em> : ""}
          </li>
        ))}
      </ul>
      <div>Subtotal ${subtotal.toFixed(2)} + tax ${tax.toFixed(2)} = <strong>${total.toFixed(2)}</strong></div>

      <MenuPicker categories={categories} onPick={pickItem} />

      {openOrders.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: "#f4f4f4", borderRadius: 6 }}>
          <strong>Kitchen orders</strong>
          <ul style={{ margin: 4 }}>
            {openOrders.map((o) => (
              <li key={o.id}>
                {groupItems(o.items).map((g) => `${g.name} x${g.count}`).join(", ")} —{" "}
                <em>{o.status.replace("_", " ").toLowerCase()}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={addCustomCharge} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input placeholder="Custom charge" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="Amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} />
        <button type="submit">Add</button>
      </form>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <LockerPicker lockers={availableForCustomer} value={newLockerId} onChange={setNewLockerId} />
        <button onClick={changeLocker}>Change locker</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
          <option value="CASH">Cash</option>
          <option value="CARD">Card</option>
          <option value="GIFT_CARD">Gift card</option>
        </select>
        <button onClick={checkOut}>Check out &amp; pay</button>
      </div>
    </li>
  );
}

function CustomerRow({ customer, lockers, isCheckedIn, onCheckedIn }: {
  customer: Customer;
  lockers: Locker[];
  isCheckedIn: boolean;
  onCheckedIn: () => void;
}) {
  const [lockerId, setLockerId] = useState("");
  const available = lockers.filter((l) => l.gender === customer.gender && l.status === "AVAILABLE");

  const checkIn = async () => {
    if (!lockerId) {
      alert("Pick a locker first");
      return;
    }
    const res = await fetch(`${API}/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: customer.id, lockerId: Number(lockerId) }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
    setLockerId("");
    onCheckedIn();
  };

  return (
    <li style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
      <strong>{customer.firstName} {customer.lastName}</strong> — {customer.gender}
      {customer.phone ? ` · ${customer.phone}` : ""}
      {customer.visitPassBalance > 0 ? ` · ${customer.visitPassBalance} passes` : ""}{" "}
      {isCheckedIn ? (
        <em>checked in</em>
      ) : (
        <>
          <LockerPicker lockers={available} value={lockerId} onChange={setLockerId} />{" "}
          <button onClick={checkIn}>Check in</button>
        </>
      )}
    </li>
  );
}

function MenuEditor({ categories, taxRate, defaultAdmissionItemId, onClose }: {
  categories: Category[];
  taxRate: number;
  defaultAdmissionItemId: number | null;
  onClose: () => void;
}) {
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryKitchen, setNewCategoryKitchen] = useState(false);
  const [newCategoryAdmission, setNewCategoryAdmission] = useState(false);
  const [taxPercent, setTaxPercent] = useState(String((taxRate * 100).toFixed(2)));
  const [defaultAdmission, setDefaultAdmission] = useState(
    defaultAdmissionItemId ? String(defaultAdmissionItemId) : ""
  );
  const [itemCategoryId, setItemCategoryId] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemVisitCredits, setItemVisitCredits] = useState("");
  const [itemRedeemsPass, setItemRedeemsPass] = useState(false);

  const admissionItems = categories.filter((c) => c.isAdmission).flatMap((c) => c.items);

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
  };

  const addCategory = async (e: FormEvent) => {
    e.preventDefault();
    if (!newCategoryName) return;
    await showError(await fetch(`${API}/categories`, {
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
    await showError(await fetch(`${API}/categories/${c.id}`, {
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
    await showError(await fetch(`${API}/categories/${id}`, { method: "DELETE" }));
  };

  const addItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!itemCategoryId || !itemName || !itemPrice) return;
    await showError(await fetch(`${API}/menu-items`, {
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
    await showError(await fetch(`${API}/menu-items/${item.id}`, {
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
    await showError(await fetch(`${API}/menu-items/${id}`, { method: "DELETE" }));
  };

  const saveTax = async () => {
    const rate = parseFloat(taxPercent) / 100;
    await showError(await fetch(`${API}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taxRate: rate }),
    }));
    alert("Tax rate saved. Applies to new check-ins; existing bills keep their rate.");
  };

  const saveDefaultAdmission = async () => {
    await showError(await fetch(`${API}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAdmissionItemId: defaultAdmission ? Number(defaultAdmission) : null }),
    }));
    alert("Default admission saved. Applies to new check-ins.");
  };

  return (
    <div style={{ border: "2px solid #333", padding: 16, marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Edit menu</h2>
        <button onClick={onClose}>Close</button>
      </div>

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
          <li key={c.id} style={{ padding: 6, borderBottom: "1px solid #eee" }}>
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

function App() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [activeVisits, setActiveVisits] = useState<Visit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [taxRate, setTaxRate] = useState(0.13);
  const [defaultAdmissionItemId, setDefaultAdmissionItemId] = useState<number | null>(null);
  const [showMenuEditor, setShowMenuEditor] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("MALE");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [lockerSearch, setLockerSearch] = useState("");

  const loadActiveVisits = () => {
    fetch(`${API}/visits/active`).then((r) => r.json()).then(setActiveVisits);
  };
  const loadLockers = () => {
    fetch(`${API}/lockers`).then((r) => r.json()).then(setLockers);
  };
  const loadMenu = () => {
    fetch(`${API}/categories`).then((r) => r.json()).then(setCategories);
  };
  const loadCustomers = () => {
    fetch(`${API}/customers`).then((r) => r.json()).then(setCustomers);
  };
  const loadSettings = () => {
    fetch(`${API}/settings`).then((r) => r.json()).then((s) => {
      setTaxRate(s.taxRate);
      setDefaultAdmissionItemId(s.defaultAdmissionItemId);
    });
  };

  useEffect(() => {
    loadCustomers();
    loadLockers();
    loadActiveVisits();
    loadMenu();
    loadSettings();

    socket.on("customer:created", (customer: Customer) => {
      setCustomers((prev) => [customer, ...prev]);
    });
    socket.on("customer:updated", () => {
      loadCustomers();
      loadActiveVisits();
    });
    socket.on("locker:updated", (locker: Locker) => {
      setLockers((prev) => prev.map((l) => (l.id === locker.id ? locker : l)));
    });
    socket.on("visit:checked-in", () => loadActiveVisits());
    socket.on("visit:locker-changed", () => loadActiveVisits());
    socket.on("visit:checked-out", (visit: { id: number }) => {
      setActiveVisits((prev) => prev.filter((v) => v.id !== visit.id));
    });
    socket.on("bill:line-item-added", () => loadActiveVisits());
    socket.on("orders:changed", () => loadActiveVisits());
    socket.on("menu:updated", () => loadMenu());
    socket.on("settings:updated", (s: { taxRate: number; defaultAdmissionItemId: number | null }) => {
      setTaxRate(s.taxRate);
      setDefaultAdmissionItemId(s.defaultAdmissionItemId);
    });

    return () => {
      socket.off("customer:created");
      socket.off("customer:updated");
      socket.off("locker:updated");
      socket.off("visit:checked-in");
      socket.off("visit:locker-changed");
      socket.off("visit:checked-out");
      socket.off("bill:line-item-added");
      socket.off("orders:changed");
      socket.off("menu:updated");
      socket.off("settings:updated");
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await fetch(`${API}/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, gender, phone, email }),
    });
    setFirstName("");
    setLastName("");
    setPhone("");
    setEmail("");
  };

  const query = search.trim().toLowerCase();
  const visibleCustomers = query
    ? customers.filter((c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(query) ||
        (c.phone ?? "").toLowerCase().includes(query)
      )
    : customers;

  const lockerQuery = lockerSearch.trim().toLowerCase();
  const visibleVisits = lockerQuery
    ? activeVisits.filter((v) => v.locker.number.toLowerCase().includes(lockerQuery))
    : activeVisits;

  const checkedInCustomerIds = new Set(activeVisits.map((v) => v.customer.id));
  const availableCount = (g: string) => lockers.filter((l) => l.gender === g && l.status === "AVAILABLE").length;
  const totalCount = (g: string) => lockers.filter((l) => l.gender === g).length;

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", maxWidth: 760 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Sauna POS</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a href="/kitchen" target="_blank">Kitchen screen</a>
          <button onClick={() => setShowMenuEditor((v) => !v)}>
            {showMenuEditor ? "Close menu editor" : "Edit menu"}
          </button>
        </div>
      </div>

      {showMenuEditor && (
        <MenuEditor
          categories={categories}
          taxRate={taxRate}
          defaultAdmissionItemId={defaultAdmissionItemId}
          onClose={() => setShowMenuEditor(false)}
        />
      )}

      <h2>Occupancy</h2>
      <p>Male lockers: {availableCount("MALE")} / {totalCount("MALE")} available</p>
      <p>Female lockers: {availableCount("FEMALE")} / {totalCount("FEMALE")} available</p>

      <h2>Currently checked in</h2>
      <input
        placeholder="Look up by locker number (e.g. M07)"
        value={lockerSearch}
        onChange={(e) => setLockerSearch(e.target.value)}
        style={{ width: "100%", padding: 8, marginBottom: 12 }}
      />
      <ul style={{ listStyle: "none", padding: 0 }}>
        {visibleVisits.map((v) => (
          <ActiveVisitRow
            key={v.id}
            visit={v}
            lockers={lockers}
            categories={categories}
            onChanged={() => { loadActiveVisits(); loadLockers(); }}
          />
        ))}
        {visibleVisits.length === 0 && (
          <li>{lockerQuery ? `No active visit for locker "${lockerSearch}".` : "Nobody checked in right now."}</li>
        )}
      </ul>

      <h2>Add a customer</h2>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        <input placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        <input placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        <select value={gender} onChange={(e) => setGender(e.target.value)}>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
        </select>
        <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit">Add customer</button>
      </form>

      <h2>All customers</h2>
      <input
        placeholder="Search by name or phone"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "100%", padding: 8, marginBottom: 12 }}
      />
      {query && <p style={{ color: "#666" }}>{visibleCustomers.length} match{visibleCustomers.length === 1 ? "" : "es"}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {visibleCustomers.map((c) => (
          <CustomerRow
            key={c.id}
            customer={c}
            lockers={lockers}
            isCheckedIn={checkedInCustomerIds.has(c.id)}
            onCheckedIn={() => { loadActiveVisits(); loadLockers(); }}
          />
        ))}
      </ul>
    </div>
  );
}

export default App;