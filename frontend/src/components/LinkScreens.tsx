"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { BetaContact } from "./BetaContact";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Card } from "./Card";
import { CopyIcon, UserIcon, UsersIcon } from "./icons";
import { LanguageSwitch } from "./LanguageSwitch";
import { LinkButton } from "./LinkButton";
import { Screen, ScreenBody, ScreenFooter, StatusHeader, screenStyles } from "./Screen";

// Screens 30, 31 and 32: what a visitor sees when a link cannot be used. The page cannot tell who
// the visitor is, so it never guesses; it lists the ways to get a new link.

/** Screen 30: link expired, cancelled or unknown (also used for password-reset links). */
export function LinkInvalidScreen() {
  const t = useTranslations("auth.link");
  const common = useTranslations("common");
  const reset = useTranslations("auth.reset");
  return (
    <Screen>
      <ScreenBody>
        <LanguageSwitch />
        <StatusHeader tone="warn" icon="clock" title={t("invalidTitle")} text={t("invalidText")} />
        <Card>
          <p className={screenStyles.label}>{t("whoToAsk")}</p>
          <ul className={screenStyles.stack} style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            <li className={screenStyles.row}>
              <UserIcon />
              <div>
                <p className={screenStyles.title}>{t("ownerTitle")}</p>
                <p className={screenStyles.muted}>{t("ownerText")}</p>
              </div>
            </li>
            <li className={screenStyles.row}>
              <UsersIcon />
              <div>
                <p className={screenStyles.title}>{t("employeeTitle")}</p>
                <p className={screenStyles.muted}>{t("employeeText")}</p>
              </div>
            </li>
          </ul>
        </Card>
        <BetaContact />
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href="/sign-in">{common("backToSignIn")}</LinkButton>
        <LinkButton href="/reset" variant="ghost">
          {reset("requestTitle")}
        </LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

/** Screen 31: the link was used before. */
export function LinkUsedScreen() {
  const t = useTranslations("auth.link");
  const common = useTranslations("common");
  return (
    <Screen>
      <ScreenBody>
        <LanguageSwitch />
        <StatusHeader tone="accent" icon="check" title={t("usedTitle")} text={t("usedText")} />
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href="/sign-in">{common("signIn")}</LinkButton>
        <LinkButton href="/reset" variant="ghost">
          {common("forgotPassword")}
        </LinkButton>
      </ScreenFooter>
    </Screen>
  );
}

/** Screen 32: identifier_unavailable. Gives no reason and says nothing about other businesses. */
export function IdentifierUnavailableScreen() {
  const t = useTranslations("auth.link");
  const common = useTranslations("common");
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(t("identifierMessage"));
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <Screen>
      <ScreenBody>
        <LanguageSwitch />
        <StatusHeader tone="info" icon="info" title={t("identifierTitle")} text={t("identifierText")} />
        <Card>
          <p className={screenStyles.label}>{t("whatToDo")}</p>
          <p className={screenStyles.muted} style={{ margin: "4px 0 8px" }}>
            {t("identifierAdvice")}
          </p>
          <p className={screenStyles.message}>{t("identifierMessage")}</p>
        </Card>
        <Button variant="ghost" onClick={copy}>
          <CopyIcon width={18} height={18} />
          {t("copyMessage")}
        </Button>
        {copied ? (
          <Banner tone={copied === "ok" ? "ok" : "bad"} icon={copied === "ok" ? "check" : "alert"} alert>
            {copied === "ok" ? t("copied") : t("copyFailed")}
          </Banner>
        ) : null}
        <BetaContact />
      </ScreenBody>
      <ScreenFooter>
        <LinkButton href="/sign-in">{common("backToSignIn")}</LinkButton>
      </ScreenFooter>
    </Screen>
  );
}
