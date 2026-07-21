import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const JWT_SECRET = process.env.JWT_SECRET || "";
if (!JWT_SECRET) {
  console.error("JWT_SECRET is missing from server/.env — see the login guide, Part 2.");
  process.exit(1);
}

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

// ---- Auth ----

type AuthedRequest = Request & { auth?: { userId: number; role: string } };

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Sign in first" });
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET) as { userId: number; role: string };
    next();
  } catch {
    res.status(401).json({ error: "Session expired — sign in again" });
  }
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.auth?.role !== "ADMIN") {
    return res.status(403).json({ error: "Only the admin login can change the menu" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Enter both a name and a passphrase" });
  }
  const user = await prisma.user.findUnique({ where: { username: String(username).toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Wrong name or passphrase" });
  }
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, user: { username: user.username, displayName: user.displayName, role: user.role } });
});

app.get("/login-roster", async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { username: true, displayName: true, role: true },
    orderBy: { role: "asc" },
  });
  res.json(users);
});

// Everything below this line requires a signed-in user
app.use(requireAuth);

// ---- Settings ----

async function getSettings() {
  return prisma.settings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, taxRate: 0.13 },
  });
}

app.get("/settings", async (_req, res) => {
  res.json(await getSettings());
});

app.put("/settings", requireAdmin, async (req, res) => {
  const { taxRate, defaultAdmissionItemId } = req.body;
  const data: { taxRate?: number; defaultAdmissionItemId?: number | null } = {};

  if (taxRate !== undefined) {
    if (typeof taxRate !== "number" || taxRate < 0 || taxRate > 1) {
      return res.status(400).json({ error: "taxRate must be a number between 0 and 1 (e.g. 0.13 for 13%)" });
    }
    data.taxRate = taxRate;
  }
  if (defaultAdmissionItemId !== undefined) {
    data.defaultAdmissionItemId = defaultAdmissionItemId === null ? null : Number(defaultAdmissionItemId);
  }

  const settings = await prisma.settings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, taxRate: data.taxRate ?? 0.13, defaultAdmissionItemId: data.defaultAdmissionItemId ?? null },
  });
  io.emit("settings:updated", settings);
  res.json(settings);
});

// ---- Menu ----

app.get("/categories", async (_req, res) => {
  const categories = await prisma.category.findMany({
    include: { items: { orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  res.json(categories);
});

app.post("/categories", requireAdmin, async (req, res) => {
  const { name, isKitchen, isAdmission } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const category = await prisma.category.create({
      data: { name, isKitchen: Boolean(isKitchen), isAdmission: Boolean(isAdmission) },
    });
    io.emit("menu:updated", {});
    res.status(201).json(category);
  } catch {
    res.status(409).json({ error: `A category named "${name}" already exists` });
  }
});

app.put("/categories/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, isKitchen, isAdmission } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const category = await prisma.category.update({
    where: { id },
    data: { name, isKitchen: Boolean(isKitchen), isAdmission: Boolean(isAdmission) },
  });
  io.emit("menu:updated", {});
  res.json(category);
});

app.delete("/categories/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const itemCount = await prisma.menuItem.count({ where: { categoryId: id } });
  if (itemCount > 0) {
    return res.status(409).json({ error: "Move or delete this category's items first" });
  }
  await prisma.category.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
});

app.post("/menu-items", requireAdmin, async (req, res) => {
  const { categoryId, name, price, description, visitCredits, redeemsPass } = req.body;
  if (!categoryId || !name || typeof price !== "number") {
    return res.status(400).json({ error: "categoryId, name, and price are required" });
  }
  const item = await prisma.menuItem.create({
    data: {
      categoryId,
      name,
      price,
      description,
      visitCredits: visitCredits || 0,
      redeemsPass: Boolean(redeemsPass),
    },
  });
  io.emit("menu:updated", {});
  res.status(201).json(item);
});

app.put("/menu-items/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { categoryId, name, price, description, visitCredits, redeemsPass } = req.body;
  const item = await prisma.menuItem.update({
    where: { id },
    data: {
      categoryId,
      name,
      price,
      description,
      visitCredits: visitCredits || 0,
      redeemsPass: Boolean(redeemsPass),
    },
  });
  io.emit("menu:updated", {});
  res.json(item);
});

app.delete("/menu-items/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.menuItem.delete({ where: { id } });
  io.emit("menu:updated", {});
  res.json({ ok: true });
});

// ---- Customers ----

app.get("/customers", async (_req, res) => {
  const customers = await prisma.customer.findMany({ orderBy: { createdAt: "desc" } });
  res.json(customers);
});

app.post("/customers", async (req, res) => {
  const { firstName, lastName, gender, phone, email, notes } = req.body;
  if (!firstName || !lastName || !gender) {
    return res.status(400).json({ error: "firstName, lastName, and gender are required" });
  }
  const customer = await prisma.customer.create({
    data: { firstName, lastName, gender, phone, email, notes },
  });
  io.emit("customer:created", customer);
  res.status(201).json(customer);
});

// ---- Lockers ----

app.get("/lockers", async (_req, res) => {
  const lockers = await prisma.locker.findMany({ orderBy: [{ gender: "asc" }, { number: "asc" }] });
  res.json(lockers);
});

app.post("/lockers", async (req, res) => {
  const { number, gender } = req.body;
  if (!number || !gender) {
    return res.status(400).json({ error: "number and gender are required" });
  }
  const locker = await prisma.locker.create({ data: { number, gender } });
  res.status(201).json(locker);
});

// ---- Visits + billing ----

app.get("/visits/active", async (_req, res) => {
  const visits = await prisma.visit.findMany({
    where: { checkOutAt: null },
    include: {
      customer: true,
      locker: true,
      bill: { include: { lineItems: true } },
      orders: { include: { items: true }, orderBy: { createdAt: "desc" } },
    },
    orderBy: { checkInAt: "desc" },
  });
  res.json(visits);
});

app.post("/check-in", async (req, res) => {
  const { customerId, lockerId } = req.body;
  if (!lockerId) {
    return res.status(400).json({ error: "Pick a locker before checking in" });
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const locker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!locker) {
    return res.status(404).json({ error: "Locker not found" });
  }
  if (locker.status !== "AVAILABLE") {
    return res.status(409).json({ error: `Locker ${locker.number} is not available` });
  }
  if (locker.gender !== customer.gender) {
    return res.status(409).json({ error: `Locker ${locker.number} is not in this customer's locker pool` });
  }

  const [updatedLocker, newVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: locker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.create({ data: { customerId: customer.id, lockerId: locker.id } }),
  ]);

  const settings = await getSettings();
  const bill = await prisma.bill.create({ data: { visitId: newVisit.id, taxRate: settings.taxRate } });

  // Pick the admission to auto-apply: a pass redemption if the customer has
  // passes banked, otherwise the configured default admission.
  // visitCredits: 0 keeps pass PACKS (items that sell credits) out of the search.
  const passAdmission = customer.visitPassBalance >= 1
    ? await prisma.menuItem.findFirst({
        where: { redeemsPass: true, visitCredits: 0, category: { isAdmission: true } },
      })
    : null;
  const admissionItem = passAdmission ??
    (settings.defaultAdmissionItemId
      ? await prisma.menuItem.findUnique({ where: { id: settings.defaultAdmissionItemId } })
      : null);
  const admissionLine = admissionItem
    ? await prisma.billLineItem.create({
        data: { billId: bill.id, description: admissionItem.name, amount: admissionItem.price, isAdmission: true },
      })
    : null;
  const checkedInVisit = passAdmission
    ? await prisma.visit.update({ where: { id: newVisit.id }, data: { redeemsPass: true } })
    : newVisit;

  const visit = {
    ...checkedInVisit,
    customer,
    locker: updatedLocker,
    bill: { ...bill, lineItems: admissionLine ? [admissionLine] : [] },
  };

  io.emit("locker:updated", updatedLocker);
  io.emit("visit:checked-in", visit);
  res.status(201).json(visit);
});

// Set (or replace) this visit's single admission charge
app.post("/visits/:visitId/set-admission", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { menuItemId } = req.body;

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: { bill: true, customer: true },
  });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  const item = await prisma.menuItem.findUnique({
    where: { id: menuItemId },
    include: { category: true },
  });
  if (!item) {
    return res.status(404).json({ error: "Menu item not found" });
  }
  if (item.visitCredits > 0) {
    return res.status(400).json({
      error: `"${item.name}" sells ${item.visitCredits} visit passes — it can't be used as an admission type`,
    });
  }
  if (!item.category.isAdmission) {
    return res.status(400).json({ error: `"${item.name}" is not an admission type` });
  }
  if (item.redeemsPass && visit.customer.visitPassBalance < 1) {
    return res.status(409).json({
      error: `${visit.customer.firstName} ${visit.customer.lastName} has no visit passes remaining`,
    });
  }

  const billId = visit.bill.id;
  await prisma.$transaction([
    prisma.billLineItem.deleteMany({ where: { billId, isAdmission: true } }),
    prisma.billLineItem.create({
      data: { billId, description: item.name, amount: item.price, isAdmission: true },
    }),
    prisma.visit.update({ where: { id: visitId }, data: { redeemsPass: item.redeemsPass } }),
  ]);

  io.emit("bill:line-item-added", { billId });
  res.json({ ok: true });
});

app.post("/visits/:visitId/change-locker", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { lockerId } = req.body;

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { customer: true } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }

  const newLocker = await prisma.locker.findUnique({ where: { id: lockerId } });
  if (!newLocker) {
    return res.status(404).json({ error: "Locker not found" });
  }
  if (newLocker.status !== "AVAILABLE") {
    return res.status(409).json({ error: `Locker ${newLocker.number} is not available` });
  }
  if (newLocker.gender !== visit.customer.gender) {
    return res.status(409).json({ error: `Locker ${newLocker.number} is not in this customer's locker pool` });
  }

  const [freedLocker, claimedLocker, updatedVisit] = await prisma.$transaction([
    prisma.locker.update({ where: { id: visit.lockerId }, data: { status: "AVAILABLE" } }),
    prisma.locker.update({ where: { id: newLocker.id }, data: { status: "OCCUPIED" } }),
    prisma.visit.update({ where: { id: visitId }, data: { lockerId: newLocker.id } }),
  ]);

  io.emit("locker:updated", freedLocker);
  io.emit("locker:updated", claimedLocker);
  io.emit("visit:locker-changed", updatedVisit);
  res.json(updatedVisit);
});

app.post("/bills/:billId/line-items", async (req, res) => {
  const billId = Number(req.params.billId);
  const { description, amount } = req.body;
  if (!description || typeof amount !== "number") {
    return res.status(400).json({ error: "description and amount are required" });
  }
  const lineItem = await prisma.billLineItem.create({ data: { billId, description, amount } });
  io.emit("bill:line-item-added", { billId, lineItem });
  res.status(201).json(lineItem);
});

// Add a kitchen item: bill it AND put it on the customer's open kitchen order, atomically
app.post("/visits/:visitId/order-item", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { name, amount } = req.body;
  if (!name || typeof amount !== "number") {
    return res.status(400).json({ error: "name and amount are required" });
  }

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { bill: true } });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  const billId = visit.bill.id;

  await prisma.$transaction(async (tx) => {
    await tx.billLineItem.create({ data: { billId, description: name, amount } });

    let order = await tx.order.findFirst({ where: { visitId, status: "QUEUED" } });
    if (!order) {
      order = await tx.order.create({ data: { visitId } });
    }
    await tx.orderItem.create({ data: { orderId: order.id, name } });
  });

  io.emit("bill:line-item-added", { billId });
  io.emit("orders:changed", {});
  res.status(201).json({ ok: true });
});

// Sell a visit pass: bill it AND credit the customer's balance, atomically
app.post("/visits/:visitId/purchase-pass", async (req, res) => {
  const visitId = Number(req.params.visitId);
  const { name, amount, visitCredits } = req.body;
  if (!name || typeof amount !== "number" || typeof visitCredits !== "number" || visitCredits <= 0) {
    return res.status(400).json({ error: "name, amount, and a positive visitCredits are required" });
  }

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { bill: true } });
  if (!visit || visit.checkOutAt || !visit.bill) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  const billId = visit.bill.id;

  const updatedCustomer = await prisma.$transaction(async (tx) => {
    await tx.billLineItem.create({ data: { billId, description: name, amount } });
    return tx.customer.update({
      where: { id: visit.customerId },
      data: { visitPassBalance: { increment: visitCredits } },
    });
  });

  io.emit("bill:line-item-added", { billId });
  io.emit("customer:updated", updatedCustomer);
  res.status(201).json({ ok: true, visitPassBalance: updatedCustomer.visitPassBalance });
});

// ---- Kitchen ----

app.get("/orders/open", async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: { not: "COMPLETE" } },
    include: { items: true, visit: { include: { customer: true, locker: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json(orders);
});

app.post("/orders/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  if (!["QUEUED", "IN_PROGRESS", "READY", "COMPLETE"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const order = await prisma.order.update({ where: { id }, data: { status } });
  io.emit("orders:changed", {});
  res.json(order);
});

app.post("/check-out", async (req, res) => {
  const { visitId, paymentMethod } = req.body;
  if (!paymentMethod) {
    return res.status(400).json({ error: "paymentMethod is required to check out" });
  }
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, include: { customer: true } });
  if (!visit || visit.checkOutAt) {
    return res.status(404).json({ error: "Active visit not found" });
  }
  if (visit.redeemsPass && visit.customer.visitPassBalance < 1) {
    return res.status(409).json({
      error: "This visit is set to use a pass, but the customer has none remaining. Change their admission type.",
    });
  }

  const { updatedVisit, updatedLocker, updatedBill, updatedCustomer } = await prisma.$transaction(async (tx) => {
    const updatedVisit = await tx.visit.update({
      where: { id: visitId },
      data: { checkOutAt: new Date() },
    });
    const updatedLocker = await tx.locker.update({
      where: { id: visit.lockerId },
      data: { status: "AVAILABLE" },
    });
    const updatedBill = await tx.bill.update({
      where: { visitId },
      data: { paymentMethod, paidAt: new Date() },
    });

    // Clear any of this visit's unfinished kitchen orders off the kitchen screen
    await tx.order.updateMany({
      where: { visitId, status: { not: "COMPLETE" } },
      data: { status: "COMPLETE" },
    });

    // Spend one visit pass, if this visit was checked in on one
    const updatedCustomer = visit.redeemsPass
      ? await tx.customer.update({
          where: { id: visit.customerId },
          data: { visitPassBalance: { decrement: 1 } },
        })
      : null;

    return { updatedVisit, updatedLocker, updatedBill, updatedCustomer };
  });

  io.emit("visit:checked-out", updatedVisit);
  io.emit("locker:updated", updatedLocker);
  io.emit("bill:paid", updatedBill);
  io.emit("orders:changed", {});
  if (updatedCustomer) io.emit("customer:updated", updatedCustomer);
  res.json({ visit: updatedVisit, bill: updatedBill });
});

io.on("connection", (socket) => {
  console.log("A terminal connected:", socket.id);
});

const port = process.env.PORT || 4000;
httpServer.listen(port, () => console.log(`Server running on http://localhost:${port}`));