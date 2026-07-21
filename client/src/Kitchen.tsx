import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { groupItems } from "./groupItems.ts";
import { authFetch } from "./authFetch.ts";

const socket = io("http://localhost:4000");

type OrderItem = { id: number; name: string };
type Order = {
  id: number;
  status: string;
  createdAt: string;
  items: OrderItem[];
  visit: {
    customer: { firstName: string; lastName: string };
    locker: { number: string };
  };
};

const COLUMNS = [
  { status: "QUEUED", title: "Queue", action: "Start prep", next: "IN_PROGRESS" },
  { status: "IN_PROGRESS", title: "In progress", action: "Mark ready", next: "READY" },
  { status: "READY", title: "Ready", action: "Picked up", next: "COMPLETE" },
];

function minutesAgo(iso: string) {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function Kitchen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const signedIn = Boolean(localStorage.getItem("token"));

  const load = () => {
    authFetch(`/orders/open`).then((r) => r.json()).then(setOrders);
  };

  useEffect(() => {
    if (!signedIn) return;
    load();
    socket.on("orders:changed", load);
    const timer = setInterval(load, 60000); // refresh "minutes ago" labels
    return () => {
      socket.off("orders:changed", load);
      clearInterval(timer);
    };
  }, [signedIn]);

  if (!signedIn) {
    return (
      <div style={{ padding: 24, fontFamily: "sans-serif" }}>
        <h1>Kitchen</h1>
        <p>Not signed in. <a href="/">Open the register</a> on this terminal first, then come back to /kitchen.</p>
      </div>
    );
  }

  const setStatus = async (orderId: number, status: string) => {
    await authFetch(`/orders/${orderId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  };

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Kitchen — {orders.length} open order{orders.length === 1 ? "" : "s"}</h1>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        {COLUMNS.map((col) => {
          const colOrders = orders.filter((o) => o.status === col.status);
          return (
            <div key={col.status} style={{ flex: 1, background: "#f4f4f4", padding: 12, borderRadius: 8 }}>
              <h2>{col.title} ({colOrders.length})</h2>
              {colOrders.map((o) => (
                <div key={o.id} style={{ background: "white", padding: 12, borderRadius: 8, marginBottom: 12 }}>
                  <strong>{o.visit.customer.firstName} {o.visit.customer.lastName}</strong>
                  {" — "}{o.visit.locker.number}
                  <span style={{ float: "right", color: "#666" }}>{minutesAgo(o.createdAt)} min</span>
                  <ul>
                    {groupItems(o.items).map((g) => (
                      <li key={g.name}>{g.name} x{g.count}</li>
                    ))}
                  </ul>
                  <button onClick={() => setStatus(o.id, col.next)} style={{ width: "100%" }}>
                    {col.action}
                  </button>
                </div>
              ))}
              {colOrders.length === 0 && <p style={{ color: "#999" }}>Empty</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Kitchen;