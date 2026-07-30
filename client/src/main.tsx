import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import Shell from "./Shell.tsx";
import Home from "./Home.tsx";
import CustomerDirectory from "./CustomerDirectory.tsx";
import PointOfSale from "./PointOfSale.tsx";
import Kitchen from "./Kitchen.tsx";
import Reports from "./Reports.tsx";
import MenuPage from "./MenuPage.tsx";
import Receipt from "./Receipt.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/receipt/:billId" element={<Receipt />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Home />} />
          <Route path="/customers" element={<CustomerDirectory />} />
          <Route path="/pos" element={<PointOfSale />} />
          <Route path="/kitchen" element={<Kitchen />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/menu" element={<MenuPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);