import { useEffect, useState } from "react";
import { io } from "socket.io-client";

const socket = io("http://localhost:4000");

function App() {
  const [pings, setPings] = useState<string[]>([]);

  useEffect(() => {
    socket.on("ping:created", (ping) => {
      setPings((prev) => [...prev, ping.message]);
    });
    return () => { socket.off("ping:created"); };
  }, []);

  const sendPing = async () => {
    await fetch("http://localhost:4000/ping", { method: "POST" });
  };

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Sauna POS — it's alive</h1>
      <button onClick={sendPing}>Send a test ping</button>
      <ul>{pings.map((p, i) => <li key={i}>{p}</li>)}</ul>
    </div>
  );
}

export default App;