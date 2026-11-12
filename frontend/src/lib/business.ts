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
}

export interface BusinessChange {
  name?: string;
  default_currency?: Currency;
  usd_lbp_rate?: string;
  default_delivery_fee?: string;
  default_delivery_fee_currency?: Currency;
}
