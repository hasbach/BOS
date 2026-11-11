import { useTranslations } from "next-intl";

import { ChatIcon } from "./icons";
import buttonStyles from "./Button.module.css";
import styles from "./Screen.module.css";

const E164 = /^\+[1-9]\d{6,14}$/;

/** wa.me link for a valid E.164 number, or null when the number is missing or malformed. */
export function whatsappUrl(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return E164.test(value) ? `https://wa.me/${value.slice(1)}` : null;
}

// Research R34: with a configured number the button opens a WhatsApp chat with Beta; without one
// only plain text is shown, so no placeholder number ever reaches a merchant.
export function BetaContact() {
  const t = useTranslations("support");
  const url = whatsappUrl(process.env.NEXT_PUBLIC_BOS_SUPPORT_WHATSAPP);

  if (!url) return <p className={styles.strongText}>{t("contact")}</p>;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${buttonStyles.button} ${buttonStyles.ghost}`}
      style={{ textDecoration: "none" }}
    >
      <ChatIcon width={18} height={18} />
      {t("whatsapp")}
    </a>
  );
}
