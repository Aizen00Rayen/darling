export interface MoneyBlock {
  count: number;
  /** Product sales (unit price x quantity), delivery fees excluded. */
  sales: number;
  /** Real purchase cost of what was sold. */
  cost: number;
  /** sales - cost. */
  margin: number;
  /** Commissions owed to influenceuses and managers on these orders (cancelled ones excluded). */
  commissions: number;
  /** margin - commissions. */
  profit: number;
}

export interface BreakdownRow {
  key: string;
  label: string;
  count: number;
  sales: number;
  profit: number;
}

export interface DayPoint {
  date: string;
  orders: number;
  sales: number;
  profit: number;
}

export interface MonthReport {
  month: string;
  /** Delivered orders plus off-site sales: money actually earned. */
  realised: MoneyBlock;
  /** New, confirmed and shipped orders: money expected. */
  pipeline: MoneyBlock;
  /** Cancelled, refused and returned orders: what was lost. */
  lost: { count: number; sales: number };
  /** Off-site sales recorded in the stock ledger (included in `realised`). */
  offsite: { units: number; sales: number; cost: number };
  /** Orders created in the month, deleted ones excluded. */
  orders: number;
  /** Delivered / (delivered + lost), as a percentage, or null when nothing is closed yet. */
  deliveryRate: number | null;
  averageBasket: number;
  bySource: BreakdownRow[];
  byProduct: BreakdownRow[];
  byWilaya: BreakdownRow[];
  daily: DayPoint[];
}
