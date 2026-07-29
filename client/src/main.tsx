import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import Kitchen from "./Kitchen.tsx";
import Reports from "./Reports.tsx";
import Receipt from "./Receipt.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/kitchen" element={<Kitchen />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/receipt/:billId" element={<Receipt />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);