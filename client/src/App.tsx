import { useEffect, useState, type FormEvent } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:4000");


type Customer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  phone: string | null;
  email: string | null;
};

type Locker = {
  id: number;
  number: string;
  gender: string;
  status: string;
};

type BillLineItem = {
  id: number;
  description: string;
  amount: number;
};

type Bill = {
  id: number;
  taxRate: number;
  lineItems: BillLineItem[];
};

type Visit = {
  id: number;
  customer: Customer;
  locker: Locker;
  bill: Bill;
};

function billTotal(bill: Bill) {
  const subtotal = bill.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = subtotal * bill.taxRate;
  return { subtotal, tax, total: subtotal + tax };
}

function ActiveVisitRow({ visit, onCheckedOut }: { visit: Visit; onCheckedOut: () => void }) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const { subtotal, tax, total } = billTotal(visit.bill);

  const addCharge = async (e: FormEvent) => {
    e.preventDefault();
    if (!description || !amount) return;
    await fetch(`http://localhost:4000/bills/${visit.bill.id}/line-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, amount: parseFloat(amount) }),
    });
    setDescription("");
    setAmount("");
  };

  const checkOut = async () => {
    await fetch("http://localhost:4000/check-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitId: visit.id, paymentMethod }),
    });
    onCheckedOut();
  };

  return (
    <li style={{ padding: 12, borderBottom: "1px solid #ddd" }}>
      <strong>{visit.customer.firstName} {visit.customer.lastName}</strong> — locker {visit.locker.number}
      <ul>
        {visit.bill.lineItems.map((item) => (
          <li key={item.id}>{item.description} — ${item.amount.toFixed(2)}</li>
        ))}
      </ul>
      <div>Subtotal ${subtotal.toFixed(2)} + tax ${tax.toFixed(2)} = <strong>${total.toFixed(2)}</strong></div>

      <form onSubmit={addCharge} style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input placeholder="Item" value={description} onChange={(e) => setDescription(e.target.value)} />
        <input placeholder="Amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} />
        <button type="submit">Add charge</button>
      </form>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
          <option value="CASH">Cash</option>
          <option value="CARD">Card</option>
          <option value="GIFT_CARD">Gift card</option>
          <option value="VISIT_PASS">Visit pass</option>
        </select>
        <button onClick={checkOut}>Check out &amp; pay</button>
      </div>
    </li>
  );
}

function App() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [activeVisits, setActiveVisits] = useState<Visit[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("MALE");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");

  const loadActiveVisits = () => {
    fetch("http://localhost:4000/visits/active").then((r) => r.json()).then(setActiveVisits);
  };

  useEffect(() => {
    fetch("http://localhost:4000/customers").then((r) => r.json()).then(setCustomers);
    fetch("http://localhost:4000/lockers").then((r) => r.json()).then(setLockers);
    loadActiveVisits();

    socket.on("customer:created", (customer: Customer) => {
      setCustomers((prev) => [customer, ...prev]);
    });
    socket.on("locker:updated", (locker: Locker) => {
      setLockers((prev) => prev.map((l) => (l.id === locker.id ? locker : l)));
    });
    socket.on("visit:checked-in", () => loadActiveVisits());
    socket.on("visit:checked-out", (visit: { id: number }) => {
      setActiveVisits((prev) => prev.filter((v) => v.id !== visit.id));
    });
    socket.on("bill:line-item-added", () => loadActiveVisits());

    return () => {
      socket.off("customer:created");
      socket.off("locker:updated");
      socket.off("visit:checked-in");
      socket.off("visit:checked-out");
      socket.off("bill:line-item-added");
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await fetch("http://localhost:4000/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, gender, phone, email }),
    });
    setFirstName("");
    setLastName("");
    setPhone("");
    setEmail("");
  };

  const checkIn = async (customerId: number) => {
    const res = await fetch("http://localhost:4000/check-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
  };
  const query = search.trim().toLowerCase();
  const visibleCustomers = query
    ? customers.filter((c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(query) ||
        (c.phone ?? "").toLowerCase().includes(query)
      )
    : customers;

  const checkedInCustomerIds = new Set(activeVisits.map((v) => v.customer.id));
  const availableCount = (g: string) => lockers.filter((l) => l.gender === g && l.status === "AVAILABLE").length;
  const totalCount = (g: string) => lockers.filter((l) => l.gender === g).length;

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", maxWidth: 640 }}>
      <h1>Sauna POS</h1>

      <h2>Occupancy</h2>
      <p>Male lockers: {availableCount("MALE")} / {totalCount("MALE")} available</p>
      <p>Female lockers: {availableCount("FEMALE")} / {totalCount("FEMALE")} available</p>

      <h2>Currently checked in</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {activeVisits.map((v) => (
          <ActiveVisitRow key={v.id} visit={v} onCheckedOut={loadActiveVisits} />
        ))}
        {activeVisits.length === 0 && <li>Nobody checked in right now.</li>}
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
          <li key={c.id} style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
            <strong>{c.firstName} {c.lastName}</strong> — {c.gender}
            {c.phone ? ` · ${c.phone}` : ""}{" "}
            {checkedInCustomerIds.has(c.id) ? <em>checked in</em> : <button onClick={() => checkIn(c.id)}>Check in</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;