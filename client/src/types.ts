// ============================================================================
// SHARED DATA SHAPES — labels describing what the server sends back.
//
// WHAT IT IS
//   None of this becomes part of the running app. These are TypeScript
//   "types": notes saying "a Customer has a firstName which is text, and a
//   visitPassBalance which is a number". They're checked before the app is
//   built and then discarded, and they exist to catch typos and wrong
//   assumptions while writing code, not to do anything at the till.
//
//   The real shapes are defined by the database, in
//   server/prisma/schema.prisma. These are the client's copy of them.
//
// WHERE IT'S USED
//   PointOfSale.tsx, Checkout.tsx, Kitchen.tsx and MenuPage.tsx.
//   Home.tsx, CustomerDirectory.tsx, Reports.tsx and Receipt.tsx each declare
//   their own narrower versions instead, because they only use a few fields.
//
// Shapes returned by the server. Two screens read the same visit, so they read
// the same description of it — change a field here and both follow.
// ============================================================================

// A guest. `visitPassBalance` is how many prepaid entries they have banked —
// see the note on MenuItem below for how those are bought and spent.
export type Customer = {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  notes: string | null;
  visitPassBalance: number;
};

// A physical locker. `gender` matters: lockers are split into a men's pool and
// a women's pool, and a guest can only be given one from their own. `status`
// is AVAILABLE, OCCUPIED or MAINTENANCE.
// Used by PointOfSale.tsx for the "Move locker…" dropdown.
export type Locker = { id: number; number: string; gender: string; status: string; maintenanceNote: string | null };

// One sellable thing. Two fields here are opposites and easy to mix up:
//   visitCredits — how many passes BUYING this grants (a 10-pack has 10).
//   redeemsPass  — whether choosing this SPENDS one of their passes.
// `imageData` is the photo, stored as a text blob rather than a file — see
// MenuPage.tsx, which shrinks uploads in the browser before saving.
// Used by PointOfSale.tsx (the tiles) and MenuPage.tsx (the editor).
export type MenuItem = {
  id: number;
  categoryId: number;
  name: string;
  price: number;
  description: string | null;
  taxRate: number;
  imageData: string | null;
  available: boolean;
  visitCredits: number;
  redeemsPass: boolean;
};

// A menu section, with its items nested inside. Two flags drive behaviour:
//   isKitchen   — ordering from here prints a cooking ticket.
//   isAdmission — these are entry charges, and picking one REPLACES the
//                 existing entry charge rather than adding to the tab.
// Used by PointOfSale.tsx, Kitchen.tsx and MenuPage.tsx.
export type Category = {
  id: number;
  name: string;
  group: string;
  isKitchen: boolean;
  isAdmission: boolean;
  items: MenuItem[];
};

// One charge on a tab. Note `taxRate` lives here, on the individual charge —
// it's copied from the menu item at the moment of sale and then frozen, so an
// old receipt always shows the tax that was actually charged that day. One
// bill can legitimately mix 13%, 5% and 0% lines.
// Used by Checkout.tsx.
export type BillLineItem = {
  id: number;
  description: string;
  amount: number;
  taxRate: number;
  isAdmission: boolean;
};

// A guest's whole tab for one stay. The `taxRate` here is the house rate as it
// stood at check-in — it's kept for history, but the real maths uses the rate
// on each line item above.
// Only ever seen nested inside a Visit.
export type Bill = { id: number; taxRate: number; lineItems: BillLineItem[] };

// A kitchen ticket. `status` walks QUEUED → IN_PROGRESS → READY → COMPLETE as
// the cooks tap through it on the Kitchen board.
// An item marked `canceled` isn't deleted — it stays visible so the kitchen
// notices something was pulled, then they dismiss it themselves.
// Only ever seen nested inside a Visit.
export type Order = {
  id: number;
  status: string;
  items: { id: number; name: string; note: string | null; canceled: boolean }[];
};

// One person's stay, and the hub everything else hangs off: who they are,
// which locker they have, what they owe, and what the kitchen is making them.
// `redeemsPass` means their entry is being paid with a prepaid pass rather
// than money — the balance is only actually deducted at checkout.
// Used by PointOfSale.tsx, Checkout.tsx and Kitchen.tsx — the "two screens
// read the same visit" the note at the top refers to.
export type Visit = {
  id: number;
  checkInAt: string;
  customer: Customer;
  locker: Locker;
  bill: Bill;
  orders: Order[];
  redeemsPass: boolean;
};