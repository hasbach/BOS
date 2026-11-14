// Shapes of the API responses used by the sign-in, activation and operator screens
// (specs/001-platform-foundation/contracts/openapi.yaml).

export type Locale = "en" | "ar";
export type Role = "owner" | "manager" | "sales" | "packing" | "dispatch";
export type Edition = "social" | "commerce";
export type Currency = "USD" | "LBP";
export type BusinessStatus = "pending" | "active" | "suspended";

export interface Me {
  user: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    locale: Locale;
    roles: Role[];
  };
  business: { id: string; name: string; edition: Edition };
  permissions: string[];
  all_stores: boolean;
  stores: Array<{ id: string; name: string; whatsapp_number: string | null; has_logo: boolean; status: "active" | "inactive" }>;
  tabs: string[];
  start_tab: string;
}

export interface InvitationPreview {
  kind: "owner_activation" | "employee";
  business_name: string;
  invitee_name: string;
  roles: Role[];
  expires_at: string;
  /** An employee invitation by email: a code must be emailed and entered before accepting. */
  code_required: boolean;
}

export interface OpsMe {
  id: string;
  name: string;
  email: string;
}

export interface OpsOwner {
  user_id: string;
  name: string;
  contact: string;
  has_email: boolean;
}

export interface OpsBusiness {
  id: string;
  name: string;
  edition: Edition;
  status: BusinessStatus;
  is_demo: boolean;
  owners: OpsOwner[];
  pending_owner_contact: string | null;
  store_count: number;
  user_count: number;
  created_at: string;
}

export interface LinkResult {
  link: string;
  expires_at: string;
}

export interface OpsBusinessCreated extends LinkResult {
  business: OpsBusiness;
}

export interface OpsBusinessCreate {
  business_name: string;
  store_name: string;
  edition: Edition;
  default_currency: Currency;
  usd_lbp_rate: string;
  owner_name: string;
  owner_phone?: string;
  owner_email?: string;
}
