// The business and its settings (contracts/openapi.yaml: /business).

import type { Currency, Edition } from "./types";

export interface Business {
  id: string;
  name: string;
  edition: Edition;
  default_currency: Currency;
  usd_lbp_rate: string;
  default_delivery_fee: string;
  default_delivery_fee_currency: Currency;
  timezone: string;
  /** M1: the low-stock level of variants that have none of their own (0 turns the warning off). */
  low_stock_default?: number;
}

export interface BusinessChange {
  name?: string;
  default_currency?: Currency;
  usd_lbp_rate?: string;
  default_delivery_fee?: string;
  default_delivery_fee_currency?: Currency;
}
