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

type Visit = {
  id: number;
  customer: Customer;
  locker: Locker;
};

function App() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [activeVisits, setActiveVisits] = useState<Visit[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("MALE");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    fetch("http://localhost:4000/customers").then((r) => r.json()).then(setCustomers);
    fetch("http://localhost:4000/lockers").then((r) => r.json()).then(setLockers);
    fetch("http://localhost:4000/visits/active").then((r) => r.json()).then(setActiveVisits);

    socket.on("customer:created", (customer: Customer) => {
      setCustomers((prev) => [customer, ...prev]);
    });
    socket.on("locker:updated", (locker: Locker) => {
      setLockers((prev) => prev.map((l) => (l.id === locker.id ? locker : l)));
    });
    socket.on("visit:checked-in", (visit: Visit) => {
      setActiveVisits((prev) => [visit, ...prev]);
    });
    socket.on("visit:checked-out", (visit: { id: number }) => {
      setActiveVisits((prev) => prev.filter((v) => v.id !== visit.id));
    });

    return () => {
      socket.off("customer:created");
      socket.off("locker:updated");
      socket.off("visit:checked-in");
      socket.off("visit:checked-out");
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

  const checkOut = async (visitId: number) => {
    await fetch("http://localhost:4000/check-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitId }),
    });
  };

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
          <li key={v.id} style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
            <strong>{v.customer.firstName} {v.customer.lastName}</strong> — locker {v.locker.number}{" "}
            <button onClick={() => checkOut(v.id)}>Check out</button>
          </li>
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
      <ul style={{ listStyle: "none", padding: 0 }}>
        {customers.map((c) => (
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