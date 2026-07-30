import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { io } from "socket.io-client";
import { authFetch } from "./authFetch.ts";
import Checkout from "./Checkout.tsx";
import { type Category, type Locker, type MenuItem, type Visit } from "./types.ts";

const socket = io("http://localhost:4000");

// One line in the cart. `qty` is what the − / + buttons change; when the order
// is confirmed the line is expanded back into `qty` separate charges, which is
// how the bill and the kitchen ticket have always counted things.
type CartLine = {
  id: string;
  name: string;
  price: number;
  isKitchen: boolean;
  visitCredits: number;
  qty: number;
};
type Cart = Record<string, CartLine>;

const PANEL: React.CSSProperties = {
  background: "#fffdf9",
  border: "1px solid rgba(43,38,32,.08)",
  borderRadius: 16,
  boxShadow: "0 1px 2px rgba(43,38,32,.04)",
};
const LABEL: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: 1.4,
  textTransform: "uppercase",
  color: "#a89a86",
};
const MICRO: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#b8ab97",
};
const BTN_GHOST: React.CSSProperties = {
  padding: "10px 16px", border: "1.5px solid #d8cebc", borderRadius: 11, background: "#fffdf9",
  color: "#5f5340", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer",
};

function money(n: number) {
  return `$${n.toFixed(2)}`;
}
function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}
function sinceLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDuration(iso: string) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}
function billTotal(visit: Visit) {
  const subtotal = visit.bill.lineItems.reduce((sum, item) => sum + item.amount, 0);
  const tax = subtotal * visit.bill.taxRate;
  return { subtotal, tax, total: subtotal + tax };
}
// Anything the kitchen still owes this guest: orders that aren't COMPLETE, not
// counting items an admin canceled.
function openKitchen(visit: Visit) {
  const orders = visit.orders.filter((o) => o.status !== "COMPLETE");
  const count = orders.reduce((n, o) => n + o.items.filter((i) => !i.canceled).length, 0);
  const ready = orders.some((o) => o.status === "READY" && o.items.some((i) => !i.canceled));
  return { count, ready };
}
function chipsFor(visit: Visit) {
  const chips: { key: string; label: string; ink: string; bg: string }[] = [];
  const notes = visit.customer.notes;
  if (notes) {
    chips.push({
      key: "notes",
      label: notes.length > 34 ? `${notes.slice(0, 34)}…` : notes,
      ink: "#8f3f28",
      bg: "#f7e4dc",
    });
  }
  const kitchen = openKitchen(visit);
  if (kitchen.count > 0) {
    chips.push(
      kitchen.ready
        ? { key: "kitchen", label: `Order ready · ${kitchen.count}`, ink: "#3f5540", bg: "#dfeada" }
        : { key: "kitchen", label: `In kitchen · ${kitchen.count}`, ink: "#7a6a53", bg: "#efe7d9" }
    );
  }
  return chips;
}

function Chip({ label, ink, bg }: { label: string; ink: string; bg: string }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: .4, color: ink, background: bg, padding: "3px 9px", borderRadius: 20 }}>
      {label}
    </span>
  );
}

function PointOfSale() {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [lockers, setLockers] = useState<Locker[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedVisitId, setSelectedVisitId] = useState<number | null>(null);
  const [checkoutVisit, setCheckoutVisit] = useState<Visit | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const [cart, setCart] = useState<Cart>({});
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [justAdded, setJustAdded] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [newLockerId, setNewLockerId] = useState("");
  const [, setTick] = useState(0);

  const [searchParams] = useSearchParams();
  const lockerParam = searchParams.get("locker") ?? "";
  const [query, setQuery] = useState(lockerParam);

  const loadVisits = () => authFetch(`/visits/active`).then((r) => r.json()).then(setVisits);
  const loadLockers = () => authFetch(`/lockers`).then((r) => r.json()).then(setLockers);
  const loadMenu = () => authFetch(`/categories`).then((r) => r.json()).then(setCategories);

  useEffect(() => {
    loadVisits();
    loadLockers();
    loadMenu();

    const refresh = () => { loadVisits(); loadLockers(); };
    socket.on("visit:checked-in", refresh);
    socket.on("visit:checked-out", refresh);
    socket.on("visit:locker-changed", refresh);
    socket.on("locker:updated", refresh);
    socket.on("bill:line-item-added", refresh);
    socket.on("orders:changed", refresh);
    socket.on("customer:updated", refresh);
    socket.on("menu:updated", loadMenu);

    const timer = setInterval(() => setTick((t) => t + 1), 60000);
    return () => {
      socket.off("visit:checked-in", refresh);
      socket.off("visit:checked-out", refresh);
      socket.off("visit:locker-changed", refresh);
      socket.off("locker:updated", refresh);
      socket.off("bill:line-item-added", refresh);
      socket.off("orders:changed", refresh);
      socket.off("customer:updated", refresh);
      socket.off("menu:updated", loadMenu);
      clearInterval(timer);
    };
  }, []);

  // Arriving from the directory's "Check out {name}" button: ?locker=M07 opens
  // that guest's order screen directly, once, as soon as the visits land.
  useEffect(() => {
    if (autoOpened || !lockerParam || visits.length === 0) return;
    setAutoOpened(true);
    const match = visits.find((v) => v.locker.number.toLowerCase() === lockerParam.toLowerCase());
    if (match) {
      setSelectedVisitId(match.id);
      setQuery("");
    }
  }, [visits, lockerParam, autoOpened]);

  // Reading the guest out of the live list (instead of holding a copy) means
  // every socket update repaints them, and a checkout elsewhere drops us back
  // to the grid automatically.
  const selected = visits.find((v) => v.id === selectedVisitId) ?? null;
  // The checkout screen is the exception: once payment goes through the visit
  // stops being active, so we fall back to the copy we were holding.
  const liveCheckoutVisit = checkoutVisit
    ? (visits.find((v) => v.id === checkoutVisit.id) ?? checkoutVisit)
    : null;

  const showError = async (res: Response) => {
    if (!res.ok) {
      const { error } = await res.json();
      alert(error);
    }
    return res.ok;
  };

  const openGuest = (id: number) => {
    setSelectedVisitId(id);
    setCart({});
    setActiveCategoryId(null);
    setJustAdded(false);
    setCustomOpen(false);
    setNewLockerId("");
  };

  const bump = (line: Omit<CartLine, "qty">, delta: number) => {
    setJustAdded(false);
    setCart((prev) => {
      const next = { ...prev };
      const qty = (next[line.id]?.qty ?? 0) + delta;
      if (qty <= 0) delete next[line.id];
      else next[line.id] = { ...line, qty };
      return next;
    });
  };

  const pickItem = async (item: MenuItem, category: Category) => {
    // Pass packs live inside the Visit category but are ordinary sales — this
    // check has to come first, or selling one would overwrite the entry charge.
    if (item.visitCredits === 0 && category.isAdmission) {
      if (!selected) return;
      await showError(await authFetch(`/visits/${selected.id}/set-admission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menuItemId: item.id }),
      }));
      return;
    }
    bump({
      id: `m${item.id}`,
      name: item.name,
      price: item.price,
      isKitchen: category.isKitchen,
      visitCredits: item.visitCredits,
    }, 1);
  };

  const addCustomCharge = (e: FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(customAmount);
    if (!customName || Number.isNaN(amount)) return;
    bump({
      id: `c${crypto.randomUUID()}`,
      name: customName,
      price: amount,
      isKitchen: false,
      visitCredits: 0,
    }, 1);
    setCustomName("");
    setCustomAmount("");
    setCustomOpen(false);
  };

  const confirmOrder = async () => {
    if (!selected || cartLines.length === 0) return;
    const items = cartLines.flatMap((line) =>
      Array.from({ length: line.qty }, () => ({
        name: line.name,
        amount: line.price,
        isKitchen: line.isKitchen,
        visitCredits: line.visitCredits,
      }))
    );
    const ok = await showError(await authFetch(`/visits/${selected.id}/confirm-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }));
    if (!ok) return;
    setCart({});
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 2200);
    loadVisits();
  };

  const changeLocker = async () => {
    if (!selected || !newLockerId) return;
    await showError(await authFetch(`/visits/${selected.id}/change-locker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockerId: Number(newLockerId) }),
    }));
    setNewLockerId("");
  };

  const goToCheckout = () => {
    if (!selected) return;
    if (cartLines.length > 0) {
      alert("There's an unconfirmed order on screen — add it to the tab or clear it first.");
      return;
    }
    setCheckoutVisit(selected);
  };

  const cartLines = Object.values(cart);
  const cartCount = cartLines.reduce((n, l) => n + l.qty, 0);
  const cartSubtotal = cartLines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const cartTax = cartSubtotal * (selected?.bill.taxRate ?? 0);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? visits.filter((v) =>
        `${v.customer.firstName} ${v.customer.lastName} ${v.locker.number}`.toLowerCase().includes(q)
      )
    : visits;

  const now = new Date();

  // Checkout takes over the whole page — still inside the Point of Sale tab,
  // so the sidebar highlight doesn't move.
  if (liveCheckoutVisit) {
    return (
      <Checkout
        visit={liveCheckoutVisit}
        onBack={() => setCheckoutVisit(null)}
        onDone={() => {
          setCheckoutVisit(null);
          setSelectedVisitId(null);
          loadVisits();
          loadLockers();
        }}
      />
    );
  }

  const header = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 26px", background: "#fffdf9", borderBottom: "1px solid rgba(43,38,32,.07)" }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Point of Sale</div>
        <div style={{ fontSize: 12, color: "#a89a86", fontWeight: 600 }}>
          {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
          {" · "}
          {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, background: "#eef4ea", border: "1px solid #cfe0c8", borderRadius: 20, padding: "6px 13px" }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#5f7a5a" }} />
        <span style={{ fontSize: 12, fontWeight: 800, color: "#3f5540" }}>{visits.length} checked in</span>
      </div>
    </div>
  );

  const listView = (
    <div style={{ padding: "22px 26px 28px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#fffdf9", border: "1.5px solid #d8cebc", borderRadius: 14, padding: "14px 18px" }}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flex: "none" }}>
          <circle cx="7.5" cy="7.5" r="5.5" stroke="#a89a86" strokeWidth="2" />
          <line x1="11.6" y1="11.6" x2="16" y2="16" stroke="#a89a86" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          className="pos-search"
          placeholder="Search checked-in guests by name or locker number"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={{ flex: "none", fontSize: 12, fontWeight: 700, color: "#a89a86" }}>
          {filtered.length} of {visits.length}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
        {filtered.map((v) => {
          const { total } = billTotal(v);
          return (
            <div
              key={v.id}
              className="pos-card"
              onClick={() => openGuest(v.id)}
              style={{ background: "#fffdf9", border: "1.5px solid rgba(43,38,32,.09)", borderRadius: 16, padding: "17px 18px", cursor: "pointer", boxShadow: "0 1px 2px rgba(43,38,32,.04)" }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 13 }}>
                <div style={{ width: 42, height: 42, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#7a6a53" }}>
                  {initials(v.customer.firstName, v.customer.lastName)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.2 }}>
                    {v.customer.firstName} {v.customer.lastName}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
                    In since {sinceLabel(v.checkInAt)} · {fmtDuration(v.checkInAt)}
                  </div>
                </div>
                <div style={{ flex: "none", textAlign: "right" }}>
                  <div style={MICRO}>Locker</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#7a6a53", lineHeight: 1.1 }}>{v.locker.number}</div>
                </div>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, minHeight: 22 }}>
                {chipsFor(v).map((c) => (
                  <Chip key={c.key} label={c.label} ink={c.ink} bg={c.bg} />
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(43,38,32,.07)" }}>
                <div>
                  <div style={MICRO}>Open tab</div>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{money(total)}</div>
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: "#7a6a53" }}>Add items →</div>
              </div>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ padding: 34, textAlign: "center", fontSize: 14, fontWeight: 600, color: "#a89a86", background: "#fffdf9", border: "1px dashed #d8cebc", borderRadius: 16 }}>
          {query ? `No checked-in guest matches “${query}”.` : "Nobody is checked in right now."}
        </div>
      )}
    </div>
  );

  const orderView = !selected ? null : (() => {
    const visit = selected;
    const tab = billTotal(visit);
    const currentAdmission = visit.bill.lineItems.find((li) => li.isAdmission) ?? null;
    const shownCategories = activeCategoryId === null
      ? categories
      : categories.filter((c) => c.id === activeCategoryId);
    const availableLockers = lockers.filter(
      (l) => l.gender === visit.customer.gender && l.status === "AVAILABLE"
    );

    return (
      <div style={{ padding: "18px 26px 26px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          onClick={() => setSelectedVisitId(null)}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: "#7a6a53", cursor: "pointer", width: "fit-content" }}
        >
          ← All checked-in guests
        </div>

        {/* guest strip */}
        <div style={{ ...PANEL, display: "flex", alignItems: "center", gap: 14, padding: "16px 20px", flexWrap: "wrap" }}>
          <div style={{ width: 48, height: 48, flex: "none", borderRadius: "50%", background: "#efe7d9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "#7a6a53" }}>
            {initials(visit.customer.firstName, visit.customer.lastName)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>
                {visit.customer.firstName} {visit.customer.lastName}
              </div>
              {chipsFor(visit).map((c) => (
                <Chip key={c.key} label={c.label} ink={c.ink} bg={c.bg} />
              ))}
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "#a89a86", marginTop: 2 }}>
              Locker {visit.locker.number} · in since {sinceLabel(visit.checkInAt)} · {fmtDuration(visit.checkInAt)}
              {visit.redeemsPass ? " · on a pass" : ""}
              {visit.customer.visitPassBalance > 0 ? ` · ${visit.customer.visitPassBalance} passes left` : ""}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
            <select className="cd-in" value={newLockerId} onChange={(e) => setNewLockerId(e.target.value)} style={{ width: 150 }}>
              <option value="">Move locker…</option>
              {availableLockers.map((l) => (
                <option key={l.id} value={l.id}>{l.number}</option>
              ))}
            </select>
            <button onClick={changeLocker} style={BTN_GHOST}>Move</button>
          </div>
          <div style={{ flex: "none", textAlign: "right", minWidth: 110 }}>
            <div style={MICRO}>Open tab</div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{money(tab.total)}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 16, alignItems: "start" }}>
          {/* menu */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[{ id: null as number | null, name: "All" }, ...categories].map((c) => {
                const on = c.id === activeCategoryId;
                return (
                  <div
                    key={c.id ?? "all"}
                    onClick={() => setActiveCategoryId(c.id)}
                    style={{ padding: "9px 16px", borderRadius: 11, border: `1.5px solid ${on ? "#7a6a53" : "#d8cebc"}`, background: on ? "#7a6a53" : "#fffdf9", color: on ? "#fffdf9" : "#5f5340", fontSize: 13, fontWeight: 800, cursor: "pointer" }}
                  >
                    {c.name}
                  </div>
                );
              })}
            </div>

            {shownCategories.map((category) => (
              <div key={category.id} style={{ ...PANEL, padding: "16px 18px" }}>
                <div style={{ ...LABEL, marginBottom: 12 }}>
                  {category.name}
                  {category.isAdmission && (
                    <span style={{ color: "#b8ab97", letterSpacing: .6, marginLeft: 8 }}>
                      · swaps the entry charge
                    </span>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  {category.items.map((item) => {
                    const isSwap = category.isAdmission && item.visitCredits === 0;
                    const qty = cart[`m${item.id}`]?.qty ?? 0;
                    const applied = isSwap && currentAdmission?.description === item.name;
                    const lit = qty > 0 || applied;
                    return (
                      <div
                        key={item.id}
                        className="pos-tile"
                        onClick={() => pickItem(item, category)}
                        title={item.description ?? ""}
                        style={{ border: `1.5px solid ${lit ? "#7a6a53" : "rgba(43,38,32,.09)"}`, background: lit ? "#f7f3ea" : "#fffdf9", borderRadius: 13, padding: "12px 13px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, minHeight: 80, justifyContent: "space-between" }}
                      >
                        <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25 }}>{item.name}</div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: "#7a6a53" }}>{money(item.price)}</span>
                          {qty > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: "#7a6a53", borderRadius: 20, padding: "2px 9px" }}>
                              {qty}
                            </span>
                          )}
                          {applied && (
                            <span style={{ fontSize: 10.5, fontWeight: 800, color: "#3f5540", background: "#dfeada", borderRadius: 20, padding: "2px 9px" }}>
                              applied
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {category.items.length === 0 && (
                    <div style={{ fontSize: 13, color: "#a89a86", fontWeight: 600 }}>Nothing in this category yet.</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* cart */}
          <div style={{ ...PANEL, overflow: "hidden", position: "sticky", top: 20 }}>
            <div style={{ padding: "15px 18px", borderBottom: "1px solid rgba(43,38,32,.07)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={LABEL}>This order</div>
              {cartLines.length > 0 && (
                <div onClick={() => setCart({})} style={{ fontSize: 11.5, fontWeight: 700, color: "#a89a86", cursor: "pointer" }}>
                  Clear
                </div>
              )}
            </div>

            {cartLines.length === 0 && (
              <div style={{ padding: "30px 20px", textAlign: "center", fontSize: 13.5, fontWeight: 600, color: "#b8ab97" }}>
                Tap menu items to build the order.
              </div>
            )}

            {cartLines.map((line) => (
              <div key={line.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: "1px solid rgba(43,38,32,.05)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.2 }}>{line.name}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "#a89a86" }}>
                    {money(line.price)} each{line.isKitchen ? " · kitchen" : ""}
                    {line.visitCredits > 0 ? ` · +${line.visitCredits} passes` : ""}
                  </div>
                </div>
                <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 7 }}>
                  <div
                    onClick={() => bump(line, -1)}
                    style={{ width: 24, height: 24, borderRadius: 7, border: "1.5px solid #d8cebc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: "#7a6a53", cursor: "pointer", lineHeight: 1 }}
                  >
                    −
                  </div>
                  <div style={{ minWidth: 16, textAlign: "center", fontSize: 13.5, fontWeight: 800 }}>{line.qty}</div>
                  <div
                    onClick={() => bump(line, 1)}
                    style={{ width: 24, height: 24, borderRadius: 7, border: "1.5px solid #d8cebc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 800, color: "#7a6a53", cursor: "pointer", lineHeight: 1 }}
                  >
                    +
                  </div>
                </div>
                <div style={{ flex: "none", width: 56, textAlign: "right", fontSize: 13.5, fontWeight: 800 }}>
                  {money(line.price * line.qty)}
                </div>
              </div>
            ))}

            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152" }}>
                <span>Subtotal</span><span>{money(cartSubtotal)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "#6b6152" }}>
                <span>Tax</span><span>{money(cartTax)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, paddingTop: 8, borderTop: "1px solid rgba(43,38,32,.08)" }}>
                <span>Order total</span><span>{money(cartSubtotal + cartTax)}</span>
              </div>

              <button
                onClick={confirmOrder}
                disabled={cartLines.length === 0}
                style={{ marginTop: 8, textAlign: "center", padding: 14, border: "none", borderRadius: 12, fontFamily: "inherit", fontSize: 14, fontWeight: 800, cursor: cartLines.length === 0 ? "default" : "pointer", background: justAdded ? "#5f7a5a" : cartLines.length > 0 ? "#7a6a53" : "#e2dacb", color: justAdded || cartLines.length > 0 ? "#fff" : "#b8ab97" }}
              >
                {justAdded
                  ? "Added to tab ✓"
                  : cartLines.length > 0
                    ? `Add ${cartCount} item${cartCount === 1 ? "" : "s"} to tab`
                    : "Add to tab"}
              </button>

              {customOpen ? (
                <form onSubmit={addCustomCharge} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <input className="cd-in" placeholder="Custom charge" value={customName} onChange={(e) => setCustomName(e.target.value)} />
                  <input className="cd-in" placeholder="Amount" type="number" step="0.01" value={customAmount} onChange={(e) => setCustomAmount(e.target.value)} />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button type="submit" style={{ ...BTN_GHOST, flex: 1 }}>Add to order</button>
                    <button type="button" onClick={() => setCustomOpen(false)} style={BTN_GHOST}>Cancel</button>
                  </div>
                </form>
              ) : (
                <div
                  onClick={() => setCustomOpen(true)}
                  style={{ textAlign: "center", fontSize: 12.5, fontWeight: 700, color: "#a89a86", cursor: "pointer" }}
                >
                  + Custom charge
                </div>
              )}

              <button
                onClick={goToCheckout}
                style={{ textAlign: "center", padding: 12, border: "1.5px solid #d8cebc", borderRadius: 12, background: "#fffdf9", color: "#5f5340", fontFamily: "inherit", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}
              >
                Go to checkout →
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  })();

  return (
    <div style={{ background: "#f4efe7", minHeight: "100vh" }}>
      {header}
      {selected ? orderView : listView}
    </div>
  );
}

export default PointOfSale;