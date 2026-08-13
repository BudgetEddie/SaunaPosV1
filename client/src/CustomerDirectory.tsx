// ============================================================================
// THE CUSTOMER DIRECTORY — the guest book, and where visits begin.
//
// WHAT IT IS
//   Two views in one file:
//     1. A searchable list of every customer.
//     2. One customer's profile: their details, their pass balance, their
//        visit history, and the button that checks them in.
//   Which one you see depends on whether a customer is selected.
//
//   Checking someone in happens HERE, not at the till. Picking a locker and
//   pressing the button opens their visit and starts their tab; the Point of
//   Sale screen then takes over for everything after that.
//
// WHERE IT'S USED
//   The "/customers" route in client/src/main.tsx. Nothing imports it.
//   Home.tsx links here from both "Check In" and "New Customer".
//   It is the only screen that sends people to /pos?locker=M07 — that address
//   is read by PointOfSale.tsx, which jumps straight to that guest.
//
// WHAT IT TALKS TO   (all in server/src/index.ts)
//   GET  /customers       → the list
//   GET  /customers/:id   → one full profile with visit history
//   GET  /lockers         → the available-locker dropdown
//   GET  /login-roster    → the "on shift" avatars
//   POST /customers       → create a guest
//   PUT  /customers/:id   → save edits (admin only)
//   POST /check-in        → open a visit, claim a locker, start a bill
// ============================================================================

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch, type LoggedInUser } from "./authFetch.ts";
import { useOverride } from "./OverrideProvider.tsx";
import { useDialog } from "./DialogProvider.tsx";
import { SponsorPicker } from "./SponsorPicker.tsx";
// This screen has its own richer customer shapes below; `Customer` is only
// borrowed for whoever the sponsor picker hands back.
import { type Customer } from "./types.ts";

// The live line to the server — opened once when the app starts, shared by
// both of the effects further down.
const socket = io("http://localhost:4000");

type Locker = { id: number; number: string; gender: string; status: string };
type RosterEntry = { username: string; displayName: string; role: string };

// This screen fetches customers two different ways, so it describes them two
// different ways.
//
// The LIST version is deliberately thin: the server sends only each person's
// most recent visit, which is enough to show "last seen" and to tell whether
// they're in the building right now (a visit with no check-out time).
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

// The PROFILE version is the whole story: every visit this person has ever
// made, each with its locker and its itemised bill.
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
// An empty form. Used to reset the "new customer" boxes after saving, and as
// their starting state. Every field is text — even the date, because that's
// what a date input hands back.
const BLANK: Draft = {
  firstName: "", lastName: "", gender: "MALE", dateOfBirth: "",
  phone: "", email: "", address: "", notes: "",
};

// Shared look-and-feel, written once and spread into the elements that use it.
// Nearly all styling in this app is written inline like this rather than in a
// stylesheet — index.css only handles the few things inline styles can't do,
// like hover effects and animations.
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
// How long a past visit lasted. A visit with no check-out time is happening
// right now, so there's no length to report yet.
function fmtSpan(startIso: string, endIso: string | null) {
  if (!endIso) return "In progress";
  const mins = Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

// Roughly what a visit came to, for the history list.
//
// Note this applies ONE tax rate to the whole bill, which is the older way of
// doing it. The Checkout and Receipt screens instead add up each charge's own
// rate. If a bill mixes rates the two answers disagree slightly — this figure
// is a summary, and Checkout is the one that takes the money.
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
  const [customers, setCustomers] = useState<ListCustomer[]>([]);   // the list
  const [lockers, setLockers] = useState<Locker[]>([]);             // for the dropdown
  const [roster, setRoster] = useState<RosterEntry[]>([]);          // "on shift" chips
  const [query, setQuery] = useState("");                           // the search box

  // Two pieces of state for one person, deliberately. `selectedId` is which
  // profile is open; `selected` is the detailed copy fetched for it. Keeping
  // the id separate is what lets the second effect below re-fetch whenever a
  // different profile is opened.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<FullCustomer | null>(null);

  const [editing, setEditing] = useState(false);       // is the edit form open
  const [draft, setDraft] = useState<Draft>(BLANK);    // ...and what's typed in it
  const [adding, setAdding] = useState(false);         // is the new-customer form open
  const [newCustomer, setNewCustomer] = useState<Draft>(BLANK);
  const [lockerId, setLockerId] = useState("");        // the chosen locker for check-in
  // Who's paying for this entry with their pass, if it isn't the guest. Null
  // means the ordinary behaviour: the guest's own pass, or a paid admission.
  const [sponsor, setSponsor] = useState<Customer | null>(null);
  const [pickingSponsor, setPickingSponsor] = useState(false);

  // Lets this screen send the browser to another address — used to hand off
  // to the till after check-in.
  const navigate = useNavigate();

  // Editing an existing profile is admin-only; creating a new guest isn't,
  // since front desk staff need to do that constantly. The server enforces
  // both — this just decides whether to show the Edit button.
  const user: LoggedInUser | null = JSON.parse(localStorage.getItem("user") ?? "null");
  const isAdmin = user?.role === "ADMIN";
  const askOverride = useOverride();
  const dialog = useDialog();

  const loadCustomers = () => authFetch(`/customers`).then((r) => r.json()).then(setCustomers);
  const loadLockers = () => authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  const loadSelected = (id: number) =>
    authFetch(`/customers/${id}`).then((r) => r.json()).then(setSelected);

  // EFFECT 1 of 2 — the list. Runs once when the screen opens, and keeps the
  // list and the locker dropdown fresh when other terminals make changes.
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

  // EFFECT 2 of 2 — the open profile.
  //
  // Runs again every time you open a different profile, so the socket handlers
  // below always refetch the person you're actually looking at.
  //
  // That's the whole reason this is separate from the effect above. The `[]`
  // there means "once, ever"; the `[selectedId]` here means "again whenever
  // that changes" — React tidies up the old listeners and registers new ones
  // pointing at the newly-opened person. A single combined effect would end up
  // forever refetching whoever was open first.
  useEffect(() => {
    // Nobody selected — we're on the list view, so there's nothing to watch.
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

  // If the server refused, pop up whatever reason it gave and report back
  // whether it worked. Callers use the answer to decide whether to carry on.
  // (The same small helper is repeated in PointOfSale.tsx and MenuPage.tsx.)
  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      await dialog.say(error, { title: "That didn't work" });
    }
    return res.ok;
  };

  // Switch from the list to one person's profile, closing any form that was
  // left open on the previous one.
  const openProfile = (id: number) => {
    setSelectedId(id);
    setEditing(false);
    setLockerId("");
  };

  // Open the edit form, pre-filled with what's currently saved.
  const startEdit = () => {
    if (!selected) return;
    setDraft({
      firstName: selected.firstName,
      lastName: selected.lastName,
      gender: selected.gender,
      // The server sends a full timestamp; a date box wants just the
      // "2026-08-04" part, so chop off the time.
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
    // Asked for on SAVE, not on "Edit profile" — so nobody summons a manager
    // for someone who opens the form and changes their mind.
    const token = await askOverride(`Edit ${selected.firstName} ${selected.lastName}'s profile`);
    if (token === null) return;
    const ok = await showError(await authFetch(`/customers/${selected.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    }, token));
    if (!ok) return;
    setEditing(false);
    loadCustomers();
    loadSelected(selected.id);
  };

  // Create a brand-new guest. Almost always happens with someone standing at
  // the desk waiting, which is why it lands on their profile afterwards rather
  // than back on the list — the next thing staff want is the check-in button.
  const addCustomer = async (e: FormEvent) => {
    e.preventDefault();
    const res = await authFetch(`/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newCustomer),
    });
    if (!(await showError(res))) return;
    // The server's answer includes the id it assigned to the new record —
    // that's how we know which profile to open.
    const created = await res.json();
    setNewCustomer(BLANK);
    setAdding(false);
    await loadCustomers();
    openProfile(created.id); // land straight on the new profile, ready to check in
  };

  // Check this guest in: claim the chosen locker, open a visit, start a tab.
  //
  // The server does the real validation — is the locker actually free, does it
  // belong to the right pool for this guest's gender — because two terminals
  // could be looking at the same free locker at the same moment. It also puts
  // the entry charge on the tab automatically, using one of the guest's
  // prepaid passes if they have any banked.
  const checkIn = async () => {
    if (!selected) return;
    if (!lockerId) {
      await dialog.say("Pick a locker first");
      return;
    }
    const ok = await showError(await authFetch(`/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerId: selected.id,
        lockerId: Number(lockerId),
        // Only sent when a sponsor was chosen. Its presence is the whole
        // difference between an ordinary pass entry and a sponsored one.
        passSponsorId: sponsor ? sponsor.id : undefined,
      }),
    }));
    if (!ok) return;
    setLockerId("");
    setSponsor(null);
    loadSelected(selected.id);
    loadCustomers();
    loadLockers();
  };

  // Hand off to the till. Putting the locker number in the address is what
  // lets PointOfSale.tsx open that exact guest's order screen straight away
  // instead of making staff search the grid for them again.
  const openCheckout = (lockerNumber: string) => {
    navigate(`/pos?locker=${encodeURIComponent(lockerNumber)}`);
  };

  // Search. Everything is done here in the browser against the already-loaded
  // list rather than by asking the server — mash the name, phone and email
  // into one string per person and see if the typed text appears anywhere.
  // Fine at this size; a directory of tens of thousands would need the server.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? customers.filter((c) =>
        `${c.firstName} ${c.lastName} ${c.phone ?? ""} ${c.email ?? ""}`.toLowerCase().includes(q)
      )
    : customers;

  // A visit with no check-out time is one still in progress — so finding one
  // means this guest is in the building right now. That's what swaps the
  // profile's button from "Check in" to "Go to their tab".
  const activeVisit = selected?.visits.find((v) => !v.checkOutAt) ?? null;

  // Only offer lockers that are free AND from this guest's pool — lockers are
  // split into men's and women's. The server checks both again on check-in.
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

  // The "new customer" form, held in a variable and dropped into the list view
  // further down. Each box follows the same pattern: show what's in `draft`,
  // and on every keystroke replace the draft with a copy that has the new
  // value. Copying rather than editing in place is a React rule — it's how it
  // notices anything changed. Only first name, last name and gender are
  // required; gender because it decides which locker pool they can use.
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

  // ---------------------------------------------------------------------------
  // VIEW 1 — the searchable list of everyone.
  // ---------------------------------------------------------------------------
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
          // The server sends only the single most recent visit per person.
          // If it has no check-out time, they never left — so they're here
          // now, which is what turns the "Last visit" column green.
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

  // ---------------------------------------------------------------------------
  // VIEW 2 — one guest's profile: details, passes, history, check-in button.
  // ---------------------------------------------------------------------------
  const detailView = !selected ? (
    // A profile was clicked but the full record hasn't arrived yet.
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
            {!editing && (
              <>
                <button onClick={startEdit} style={BTN_GHOST}>Edit profile</button>
                <div style={{ fontSize: 10.5, fontWeight: 600, color: "#b8ab97" }}>
                  {isAdmin ? "Admin" : "Needs approval"}
                </div>
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

        {/* The same details, in one of two states: editable boxes, or plain
            read-only text. Only admins ever see the Edit button that flips it.
            One thing the server won't allow: changing gender while the guest
            is mid-visit, since they'd be holding a locker from the wrong pool. */}
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
          {/* The 12 most recent visits, newest first. Anything older is just
              counted in a line at the bottom. */}
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
      {/* The button at the bottom of the profile is whichever one makes sense:
          someone already in the building gets sent to their tab; everyone else
          gets a locker dropdown and a check-in button. */}
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
            {/* Someone else's pass. Without this the app quietly uses the
                guest's own if they have one, which is right almost always —
                this is the exception for a member bringing a friend. */}
            {sponsor ? (
              <button
                onClick={() => setSponsor(null)}
                title="Stop using their pass"
                style={{ ...BTN_GHOST, flex: "none", maxWidth: 260, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderColor: "#7a6a53", color: "#7a6a53" }}
              >
                Pass from {sponsor.firstName} {sponsor.lastName} ✕
              </button>
            ) : (
              <button onClick={() => setPickingSponsor(true)} style={{ ...BTN_GHOST, flex: "none" }}>
                Sponsored pass…
              </button>
            )}
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

  // The header is always there; below it, one of the two views built above —
  // nobody selected means the list, otherwise the profile.
  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {header}
      {selectedId === null ? listView : detailView}
      {/* Floats above whichever view is showing. Choosing only records who
          will pay — nothing is taken until the guest checks out. */}
      {pickingSponsor && (
        <SponsorPicker
          onPick={(c) => {
            setSponsor(c);
            setPickingSponsor(false);
          }}
          onCancel={() => setPickingSponsor(false)}
        />
      )}
    </div>
  );
}

export default CustomerDirectory;