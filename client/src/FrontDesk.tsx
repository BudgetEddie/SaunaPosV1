import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { groupItems } from "./groupItems.ts";
import { authFetch } from "./authFetch.ts";

const socket = io("http://localhost:4000");

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

type Order = { id: number; status: string; items: { id: number; name: string; canceled: boolean }[] };
type Visit = {
  id: number;
  customer: Customer;
  locker: Locker;
  bill: Bill;
  orders: Order[];
  redeemsPass: boolean;
};

type PendingItem = {
  key: string;
  name: string;
  amount: number;
  isKitchen: boolean;
  visitCredits: number;
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

function ActiveVisitRow({ visit, lockers, categories, isAdmin, onChanged }: {
  visit: Visit;
  lockers: Locker[];
  categories: Category[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [newLockerId, setNewLockerId] = useState("");
  const [pending, setPending] = useState<PendingItem[]>([]);
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

  const addPending = (name: string, amount: number, isKitchen: boolean, visitCredits: number) => {
    setPending((prev) => [...prev, { key: crypto.randomUUID(), name, amount, isKitchen, visitCredits }]);
  };

  const removePending = (key: string) => {
    setPending((prev) => prev.filter((p) => p.key !== key));
  };

  const pickItem = async (item: MenuItem) => {
    const category = categories.find((c) => c.id === item.categoryId);

    if (item.visitCredits === 0 && category?.isAdmission) {
      // Admission is a swap, not an add — it stays instant
      await showError(await authFetch(`/visits/${visit.id}/set-admission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: item.id }),
      }));
      onChanged();
      return;
    }

    // Everything else waits in the pending order until confirmed
    addPending(item.name, item.price, Boolean(category?.isKitchen), item.visitCredits);
  };

  const addCustomCharge = (e: FormEvent) => {
    e.preventDefault();
    if (!description || !amount) return;
    addPending(description, parseFloat(amount), false, 0);
    setDescription("");
    setAmount("");
  };

  const confirmOrder = async () => {
    if (pending.length === 0) return;
    const res = await authFetch(`/visits/${visit.id}/confirm-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: pending.map((p) => ({
          name: p.name,
          amount: p.amount,
          isKitchen: p.isKitchen,
          visitCredits: p.visitCredits,
        })),
      }),
    });
    await showError(res);
    if (res.ok) setPending([]);
    onChanged();
  };

  const removeLineItem = async (item: BillLineItem) => {
    if (!confirm(`Remove "${item.description}" ($${item.amount.toFixed(2)}) from this bill?`)) return;
    await showError(await authFetch(`/bills/${visit.bill.id}/line-items/${item.id}`, { method: "DELETE" }));
    onChanged();
  };

  const changeLocker = async () => {
    if (!newLockerId) return;
    await showError(await authFetch(`/visits/${visit.id}/change-locker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockerId: Number(newLockerId) }),
    }));
    setNewLockerId("");
    onChanged();
  };

  const checkOut = async () => {
    if (pending.length > 0) {
      alert("This visit has an unconfirmed pending order — confirm it or clear it first.");
      return;
    }
    await showError(await authFetch(`/check-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitId: visit.id, paymentMethod }),
    }));
    onChanged();
  };

  // On the POS side, canceled kitchen items are simply hidden (the bill line is
  // already gone); the kitchen screen is where the cancellation is displayed.
  const openOrders = visit.orders.filter(
    (o) => o.status !== "COMPLETE" && o.items.some((i) => !i.canceled)
  );
  const pendingTotal = pending.reduce((sum, p) => sum + p.amount, 0);

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
            {isAdmin && !item.isAdmission && (
              <>
                {" "}
                <button onClick={() => removeLineItem(item)} title="Remove from bill (admin)">Remove</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div>Subtotal ${subtotal.toFixed(2)} + tax ${tax.toFixed(2)} = <strong>${total.toFixed(2)}</strong></div>

      <MenuPicker categories={categories} onPick={pickItem} />

      {pending.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, border: "2px dashed #b5563a", borderRadius: 6 }}>
          <strong>Pending order</strong> <em style={{ color: "#666" }}>— not on the bill yet</em>
          <ul style={{ margin: 4 }}>
            {pending.map((p) => (
              <li key={p.key}>
                {p.name} — ${p.amount.toFixed(2)}
                {p.isKitchen ? " · kitchen" : ""}
                {p.visitCredits > 0 ? ` · grants ${p.visitCredits} visits` : ""}{" "}
                <button onClick={() => removePending(p.key)}>✕</button>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>Pending total: ${pendingTotal.toFixed(2)}</span>
            <button onClick={confirmOrder} style={{ fontWeight: 700 }}>Confirm order</button>
            <button onClick={() => setPending([])}>Clear all</button>
          </div>
        </div>
      )}

      {openOrders.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: "#f4f4f4", borderRadius: 6 }}>
          <strong>Kitchen orders</strong>
          <ul style={{ margin: 4 }}>
            {openOrders.map((o) => (
              <li key={o.id}>
                {groupItems(o.items.filter((i) => !i.canceled)).map((g) => `${g.name} x${g.count}`).join(", ")} —{" "}
                <em>{o.status.replace("_", " ").toLowerCase()}</em>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={addCustomCharge} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input placeholder="Custom charge" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="Amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} />
        <button type="submit">Add to order</button>
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
    const res = await authFetch(`/check-in`, {
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

function FrontDesk() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [activeVisits, setActiveVisits] = useState<Visit[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("MALE");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [searchParams] = useSearchParams();
  const [lockerSearch, setLockerSearch] = useState(searchParams.get("locker") ?? "");

  const user = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const loadActiveVisits = () => {
    authFetch(`/visits/active`).then((r) => r.json()).then(setActiveVisits);
  };
  const loadLockers = () => {
    authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  };
  const loadMenu = () => {
    authFetch(`/categories`).then((r) => r.json()).then(setCategories);
  };
  const loadCustomers = () => {
    authFetch(`/customers`).then((r) => r.json()).then(setCustomers);
  };

  useEffect(() => {
    loadCustomers();
    loadLockers();
    loadActiveVisits();
    loadMenu();

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
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await authFetch(`/customers`, {
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

  return (
    <div style={{ padding: "18px 26px 30px", maxWidth: 760 }}>
      <h1 style={{ margin: "0 0 12px", fontSize: 22, fontWeight: 800 }}>Front desk</h1>

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
            isAdmin={isAdmin}
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

export default FrontDesk;