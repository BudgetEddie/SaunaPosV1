import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch, type LoggedInUser } from "./authFetch.ts";

const socket = io("http://localhost:4000");

type Locker = { id: number; number: string; gender: string; status: string };
type RosterEntry = { username: string; displayName: string; role: string };

type ListVisit = { id: number; checkInAt: string; checkOutAt: string | null };
type ListCustomer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  phone: string | null;
  email: string | null;
  visitPassBalance: number;
  visits: ListVisit[];
};

type FullVisit = {
  id: number;
  checkInAt: string;
  checkOutAt: string | null;
  locker: { number: string };
  bill: { id: number; taxRate: number; lineItems: { id: number; amount: number }[] } | null;
};
type FullCustomer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  address: string | null;
  notes: string | null;
  visitPassBalance: number;
  visits: FullVisit[];
};

// One shape for both the "edit this profile" form and the "new customer" form.
type Draft = {
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
};
const BLANK: Draft = {
  firstName: "", lastName: "", gender: "MALE", dateOfBirth: "",
  phone: "", email: "", address: "", notes: "",
};

const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 16,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const LABEL: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "#a89a86",
};
const BTN_PRIMARY: React.CSSProperties = {
  padding: "12px 20px", border: "none", borderRadius: 12, background: "#7a6a53",
  color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: "pointer",
};
const BTN_GHOST: React.CSSProperties = {
  padding: "12px 18px", border: "1.5px solid #d8cebc", borderRadius: 12, background: "#fffdf9",
  color: "#5f5340", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer",
};
const COLS = "1.9fr .8fr 1.2fr 1.1fr 1.1fr";

function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}
function nameInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  return initials(parts[0] ?? "", parts[1] ?? "");
}
function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return `${fmtDate(iso)} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
function fmtDob(iso: string | null) {
  if (!iso) return "—";
  // A birthday is stored at UTC midnight, so read it back in UTC — otherwise
  // being west of Greenwich would show everyone as born a day earlier.
  return new Date(iso).toLocaleDateString([], {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}
function fmtSpan(startIso: string, endIso: string | null) {
  if (!endIso) return "In progress";
  const mins = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
function visitTotal(visit: FullVisit) {
  if (!visit.bill) return 0;
  const subtotal = visit.bill.lineItems.reduce((sum, i) => sum + i.amount, 0);
  return subtotal + subtotal * visit.bill.taxRate;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ ...LABEL, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
function Value({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 15, fontWeight: 700, color: "#2b2620" }}>{children}</div>;
}

function CustomerDirectory() {
  const [customers, setCustomers] = useState<ListCustomer[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<FullCustomer | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [adding, setAdding] = useState(false);
  const [newCustomer, setNewCustomer] = useState<Draft>(BLANK);
  const [lockerId, setLockerId] = useState("");
  const navigate = useNavigate();

  const user: LoggedInUser | null = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";

  const loadCustomers = () => authFetch(`/customers`).then((r) => r.json()).then(setCustomers);
  const loadLockers = () => authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  const loadSelected = (id: number) =>
    authFetch(`/customers/${id}`).then((r) => r.json()).then(setSelected);

  useEffect(() => {
    loadCustomers();
    loadLockers();
    authFetch(`/login-roster`).then((r) => r.json()).then(setRoster);

    const refresh = () => { loadCustomers(); loadLockers(); };
    socket.on("customer:created", refresh);
    socket.on("customer:updated", refresh);
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("locker:updated", refresh);
    return () => {
      socket.off("customer:created", refresh);
      socket.off("customer:updated", refresh);
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("locker:updated", refresh);
    };
  }, []);

  // Runs again every time you open a different profile, so the socket handlers
  // below always refetch the person you're actually looking at.
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const load = () => loadSelected(selectedId);
    load();
    socket.on("visit:checked-in", load);
    socket.on("visit:checked-out", load);
    socket.on("bill:line-item-added", load);
    socket.on("customer:updated", load);
    return () => {
      socket.off("visit:checked-in", load);
      socket.off("visit:checked-out", load);
      socket.off("bill:line-item-added", load);
      socket.off("customer:updated", load);
    };
  }, [selectedId]);

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
    return res.ok;
  };

  const openProfile = (id: number) => {
    setSelectedId(id);
    setEditing(false);
    setLockerId("");
  };

  const startEdit = () => {
    if (!selected) return;
    setDraft({
      firstName: selected.firstName,
      lastName: selected.lastName,
      gender: selected.gender,
      dateOfBirth: selected.dateOfBirth ? selected.dateOfBirth.slice(0, 10) : "",
      phone: selected.phone ?? "",
      email: selected.email ?? "",
      address: selected.address ?? "",
      notes: selected.notes ?? "",
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selected) return;
    const ok = await showError(await authFetch(`/customers/${selected.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }));
    if (!ok) return;
    setEditing(false);
    loadCustomers();
    loadSelected(selected.id);
  };

  const addCustomer = async (e: FormEvent) => {
    e.preventDefault();
    const res = await authFetch(`/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newCustomer),
    });
    if (!(await showError(res))) return;
    const created = await res.json();
    setNewCustomer(BLANK);
    setAdding(false);
    await loadCustomers();
    openProfile(created.id); // land straight on the new profile, ready to check in
  };

  const checkIn = async () => {
    if (!selected) return;
    if (!lockerId) {
      alert("Pick a locker first");
      return;
    }
    const ok = await showError(await authFetch(`/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: selected.id, lockerId: Number(lockerId) }),
    }));
    if (!ok) return;
    setLockerId("");
    loadSelected(selected.id);
    loadCustomers();
    loadLockers();
  };

  const openCheckout = (lockerNumber: string) => {
    navigate(`/frontdesk?locker=${encodeURIComponent(lockerNumber)}`);
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? customers.filter((c) =>
        `${c.firstName} ${c.lastName} ${c.phone ?? ""} ${c.email ?? ""}`.toLowerCase().includes(q)
      )
    : customers;

  const activeVisit = selected?.visits.find((v) => !v.checkOutAt) ?? null;
  const availableLockers = selected
    ? lockers.filter((l) => l.gender === selected.gender && l.status === "AVAILABLE")
    : [];

  const now = new Date();

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Customer Directory</div>
        <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>On shift</div>
          <div style={{ display: "flex" }}>
            {roster.map((s) => (
              <div
                key={s.username}
                title={`${s.displayName} · ${s.role === "ADMIN" ? "Admin" : "Staff"}`}
                style={{ width: 28, height: 28, borderRadius: "50%", background: "#efe7d9", border: "2px solid #fffdf9", marginLeft: -5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#7a6a53" }}
              >
                {nameInitials(s.displayName)}
              </div>
            ))}
          </div>
        </div>
        <div style={{ width: 1, height: 30, background: "rgba(43,38,32,.1)" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#3a332a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff" }}>
            {nameInitials(user?.displayName ?? "")}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, lineHeight: 1.1 }}>{user?.displayName}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#7a6a53" }}>{isAdmin ? "Admin" : "Staff"}</div>
          </div>
        </div>
      </div>
    </div>
  );

  const newCustomerForm = (
    <form onSubmit={addCustomer} style={{ ...PANEL, padding: 20, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px 20px" }}>
      <Field label="First name">
        <input className="cd-in" value={newCustomer.firstName} onChange={(e) => setNewCustomer({ ...newCustomer, firstName: e.target.value })} required />
      </Field>
      <Field label="Last name">
        <input className="cd-in" value={newCustomer.lastName} onChange={(e) => setNewCustomer({ ...newCustomer, lastName: e.target.value })} required />
      </Field>
      <Field label="Gender">
        <select className="cd-in" value={newCustomer.gender} onChange={(e) => setNewCustomer({ ...newCustomer, gender: e.target.value })}>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
        </select>
      </Field>
      <Field label="Date of birth">
        <input className="cd-in" type="date" value={newCustomer.dateOfBirth} onChange={(e) => setNewCustomer({ ...newCustomer, dateOfBirth: e.target.value })} />
      </Field>
      <Field label="Phone">
        <input className="cd-in" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
      </Field>
      <Field label="Email">
        <input className="cd-in" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
      </Field>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field label="Address">
          <input className="cd-in" value={newCustomer.address} onChange={(e) => setNewCustomer({ ...newCustomer, address: e.target.value })} />
        </Field>
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field label="Notes & comments">
          <textarea className="cd-ta" value={newCustomer.notes} onChange={(e) => setNewCustomer({ ...newCustomer, notes: e.target.value })} placeholder="Allergies, preferences, anything the desk should know" />
        </Field>
      </div>
      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 10 }}>
        <button type="submit" style={BTN_PRIMARY}>Add customer</button>
        <button type="button" onClick={() => { setAdding(false); setNewCustomer(BLANK); }} style={BTN_GHOST}>Cancel</button>
      </div>
    </form>
  );

  const listView = (
    <div style={{ padding: "22px 26px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, background: "#fffdf9", border: "1.5px solid #d8cebc", borderRadius: 14, padding: "14px 18px" }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flex: "none" }}>
            <circle cx="7.5" cy="7.5" r="5.5" stroke="#a89a86" strokeWidth="2" />
            <line x1="11.6" y1="11.6" x2="16" y2="16" stroke="#a89a86" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            className="cd-search"
            placeholder="Search by name, phone, or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={{ flex: "none", fontSize: 12, fontWeight: 700, color: "#a89a86" }}>
            {filtered.length} of {customers.length}
          </div>
        </div>
        <button onClick={() => setAdding((a) => !a)} style={{ ...BTN_PRIMARY, borderRadius: 14, padding: "0 22px", flex: "none" }}>
          {adding ? "Close" : "+ New customer"}
        </button>
      </div>

      {adding && newCustomerForm}

      <div style={{ ...PANEL, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 14, padding: "12px 20px", borderBottom: "1px solid rgba(43,38,32,.06)" }}>
          {["Name", "Gender", "Phone", "Last visit", "Visit pass"].map((h) => (
            <div key={h} style={{ ...LABEL, fontSize: 10, letterSpacing: 1, color: "#b8ab97" }}>{h}</div>
          ))}
        </div>

        {filtered.map((c) => {
          const last = c.visits[0] ?? null;
          const here = last !== null && last.checkOutAt === null;
          return (
            <div
              key={c.id}
              className="cd-row"
              onClick={() => openProfile(c.id)}
              style={{ display: "grid", gridTemplateColumns: COLS, gap: 14, alignItems: "center", padding: "14px 20px", borderBottom: "1px solid rgba(43,38,32,.05)", cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <div style={{ width: 36, height: 36, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#7a6a53" }}>
                  {initials(c.firstName, c.lastName)}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700 }}>{c.firstName} {c.lastName}</div>
                  <div style={{ fontSize: 11, color: "#a89a86", fontWeight: 600 }}>{c.email ?? "—"}</div>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "#6b6152", fontWeight: 600 }}>{titleCase(c.gender)}</div>
              <div style={{ fontSize: 13, color: "#6b6152", fontWeight: 600 }}>{c.phone ?? "—"}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: here ? "#5f7a5a" : "#6b6152" }}>
                {last ? (here ? "Here now" : fmtDate(last.checkInAt)) : "—"}
              </div>
              <div>
                {c.visitPassBalance > 0 ? (
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#5f7a5a" }}>
                    {c.visitPassBalance} left
                  </span>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#a89a86", background: "#f0ebe1", padding: "3px 10px", borderRadius: 20 }}>
                    Walk-in
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ padding: 26, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86" }}>
            {query ? `No customer matches “${query}”.` : "No customers yet — add the first one above."}
          </div>
        )}
      </div>
    </div>
  );

  const detailView = !selected ? (
    <div style={{ padding: 26, color: "#a89a86", fontWeight: 600 }}>Loading…</div>
  ) : (
    <div style={{ padding: "20px 26px 26px", display: "flex", flexDirection: "column", gap: 18 }}>
      <div
        onClick={() => { setSelectedId(null); setEditing(false); }}
        style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#7a6a53", cursor: "pointer", width: "fit-content" }}
      >
        ← Back to directory
      </div>

      {/* identity card */}
      <div style={{ ...PANEL, borderRadius: 18, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          <div style={{ width: 76, height: 76, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, fontWeight: 800, color: "#7a6a53" }}>
            {initials(selected.firstName, selected.lastName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 23, fontWeight: 800 }}>{selected.firstName} {selected.lastName}</div>
              {selected.notes && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#8f3f28", background: "#f7e4dc", padding: "3px 10px", borderRadius: 20 }}>
                  {selected.notes.length > 40 ? `${selected.notes.slice(0, 40)}…` : selected.notes}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.5, color: "#a89a86", fontWeight: 600, marginTop: 3 }}>
              {selected.visits.length} visit{selected.visits.length === 1 ? "" : "s"} on file
            </div>
          </div>
          <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
            {!editing && isAdmin && (
              <>
                <button onClick={startEdit} style={BTN_GHOST}>Edit profile</button>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: "#b8ab97" }}>Admin only</div>
              </>
            )}
            {editing && (
              <>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEditing(false)} style={BTN_GHOST}>Cancel</button>
                  <button onClick={saveEdit} style={BTN_PRIMARY}>Save</button>
                </div>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: "#b8ab97" }}>Editing all fields</div>
              </>
            )}
          </div>
        </div>

        <div style={{ height: 1, background: "rgba(43,38,32,.08)", margin: "20px 0" }} />

        {editing ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 28px" }}>
            <Field label="First name">
              <input className="cd-in" value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
            </Field>
            <Field label="Last name">
              <input className="cd-in" value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
            </Field>
            <Field label="Gender">
              <select className="cd-in" value={draft.gender} onChange={(e) => setDraft({ ...draft, gender: e.target.value })}>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
              </select>
            </Field>
            <Field label="Date of birth">
              <input className="cd-in" type="date" value={draft.dateOfBirth} onChange={(e) => setDraft({ ...draft, dateOfBirth: e.target.value })} />
            </Field>
            <Field label="Phone">
              <input className="cd-in" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <input className="cd-in" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </Field>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Address">
                <input className="cd-in" value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
              </Field>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <Field label="Notes & comments">
                <textarea className="cd-ta" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </Field>
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 28px" }}>
              <Field label="Gender"><Value>{titleCase(selected.gender)}</Value></Field>
              <Field label="Date of birth"><Value>{fmtDob(selected.dateOfBirth)}</Value></Field>
              <Field label="Phone"><Value>{selected.phone || "—"}</Value></Field>
              <Field label="Email"><Value>{selected.email || "—"}</Value></Field>
              <div style={{ gridColumn: "1 / -1" }}>
                <Field label="Address"><Value>{selected.address || "—"}</Value></Field>
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <div style={{ ...LABEL, marginBottom: 8 }}>Notes &amp; comments</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#6b6152", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                {selected.notes || "No notes on file."}
              </div>
            </div>
          </>
        )}
      </div>

      {/* history + right stack */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18, alignItems: "start" }}>
        <div style={{ ...PANEL, borderRadius: 18, overflow: "hidden" }}>
          <div style={{ ...LABEL, fontSize: 13, letterSpacing: 1.5, padding: "18px 22px", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
            Visit history
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr .8fr .8fr", gap: 12, padding: "10px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
            {["Date & time", "Duration", "Locker", "Total"].map((h) => (
              <div key={h} style={{ ...LABEL, fontSize: 10, letterSpacing: 1, color: "#b8ab97" }}>{h}</div>
            ))}
          </div>
          {selected.visits.slice(0, 12).map((v) => (
            <div key={v.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr .8fr .8fr", gap: 12, alignItems: "center", padding: "13px 22px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{fmtDateTime(v.checkInAt)}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: v.checkOutAt ? "#6b6152" : "#5f7a5a" }}>
                {fmtSpan(v.checkInAt, v.checkOutAt)}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#7a6a53" }}>{v.locker.number}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#6b6152" }}>${visitTotal(v).toFixed(2)}</div>
            </div>
          ))}
          {selected.visits.length === 0 && (
            <div style={{ padding: 22, fontSize: 14, fontWeight: 600, color: "#a89a86" }}>No visits yet.</div>
          )}
          {selected.visits.length > 12 && (
            <div style={{ padding: "12px 22px", fontSize: 12, fontWeight: 600, color: "#a89a86" }}>
              + {selected.visits.length - 12} earlier visit{selected.visits.length - 12 === 1 ? "" : "s"}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ ...PANEL, borderRadius: 18, padding: 20 }}>
            <div style={{ ...LABEL, letterSpacing: 1.5, marginBottom: 10 }}>Visit pass</div>
            {selected.visitPassBalance > 0 ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 38, fontWeight: 800, lineHeight: 1, color: "#5f7a5a" }}>
                  {selected.visitPassBalance}
                </span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#a89a86" }}>
                  visit{selected.visitPassBalance === 1 ? "" : "s"} left
                </span>
              </div>
            ) : (
              <div style={{ fontSize: 15, fontWeight: 700, color: "#a89a86" }}>No active pass · walk-in</div>
            )}
            <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, color: "#a89a86", lineHeight: 1.5 }}>
              Passes are sold from the menu during a visit, and one is redeemed automatically at the next check-in.
            </div>
          </div>

          {activeVisit && (
            <div
              onClick={() => openCheckout(activeVisit.locker.number)}
              style={{ background: "#eef4ea", border: "1px solid #cfe0c8", borderRadius: 18, padding: "18px 20px", cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#5f7a5a" }} />
                <span style={{ ...LABEL, letterSpacing: 1, color: "#5f7a5a", fontWeight: 800 }}>Currently checked in</span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: "#6b6152", fontWeight: 600 }}>Locker</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#3f5540" }}>{activeVisit.locker.number}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 12, color: "#6b6152", fontWeight: 600 }}>Bill so far</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#3f5540" }}>${visitTotal(activeVisit).toFixed(2)}</div>
                </div>
              </div>
              <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 800, color: "#5f7a5a" }}>Open checkout →</div>
            </div>
          )}
        </div>
      </div>

      {/* the one big action */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {activeVisit ? (
          <button
            onClick={() => openCheckout(activeVisit.locker.number)}
            style={{ ...BTN_PRIMARY, flex: 1, padding: 16, fontSize: 15, borderRadius: 14, boxShadow: "0 10px 22px -12px rgba(122,106,83,.85)" }}
          >
            Check out {selected.firstName}
          </button>
        ) : (
          <>
            <select className="cd-in" value={lockerId} onChange={(e) => setLockerId(e.target.value)} style={{ width: 220, flex: "none" }}>
              <option value="">Select locker…</option>
              {availableLockers.map((l) => (
                <option key={l.id} value={l.id}>{l.number}</option>
              ))}
            </select>
            <button
              onClick={checkIn}
              style={{ ...BTN_PRIMARY, flex: 1, padding: 16, fontSize: 15, borderRadius: 14, boxShadow: "0 10px 22px -12px rgba(122,106,83,.85)" }}
            >
              Check in {selected.firstName}
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {header}
      {selectedId === null ? listView : detailView}
    </div>
  );
}

export default CustomerDirectory;