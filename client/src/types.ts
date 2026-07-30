// Shapes returned by the server. Two screens read the same visit, so they read
// the same description of it — change a field here and both follow.

export type Customer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  notes: string | null;
  visitPassBalance: number;
};

export type Locker = { id: number; number: string; gender: string; status: string };

export type MenuItem = {
  id: number;
  categoryId: number;
  name: string;
  price: number;
  description: string | null;
  visitCredits: number;
  redeemsPass: boolean;
};

export type Category = {
  id: number;
  name: string;
  isKitchen: boolean;
  isAdmission: boolean;
  items: MenuItem[];
};

export type BillLineItem = { id: number; description: string; amount: number; isAdmission: boolean };

export type Bill = { id: number; taxRate: number; lineItems: BillLineItem[] };

export type Order = {
  id: number;
  status: string;
  items: { id: number; name: string; canceled: boolean }[];
};

export type Visit = {
  id: number;
  checkInAt: string;
  customer: Customer;
  locker: Locker;
  bill: Bill;
  orders: Order[];
  redeemsPass: boolean;
};