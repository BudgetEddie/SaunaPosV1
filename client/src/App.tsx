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

function App() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [gender, setGender] = useState("MALE");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    fetch("http://localhost:4000/customers")
      .then((r) => r.json())
      .then(setCustomers);

    socket.on("customer:created", (customer: Customer) => {
      setCustomers((prev) => [customer, ...prev]);
    });
    return () => { socket.off("customer:created"); };
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

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", maxWidth: 480 }}>
      <h1>Sauna POS — Customers</h1>

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

      <ul style={{ listStyle: "none", padding: 0 }}>
        {customers.map((c) => (
          <li key={c.id} style={{ padding: 8, borderBottom: "1px solid #ddd" }}>
            <strong>{c.firstName} {c.lastName}</strong> — {c.gender}
            {c.phone ? ` · ${c.phone}` : ""}
            {c.email ? ` · ${c.email}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;