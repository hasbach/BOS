"use client";

import { useTranslations } from "next-intl";

import { AppBar } from "@/components/AppBar";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { ChevronIcon, PlusIcon, StoreIcon } from "@/components/icons";
import { LinkButton } from "@/components/LinkButton";
import { Screen, ScreenBody, ScreenFooter, screenStyles } from "@/components/Screen";
import { Link } from "@/i18n/navigation";
import { useMe } from "@/lib/session";
import { STORES, formatWhatsapp } from "@/lib/stores";
import type { Store } from "@/lib/stores";

import employees from "../employees/employees.module.css";
import { StatusChip, StoreLogo, StoresLoader, useStoreAccess } from "./parts";
import styles from "./stores.module.css";

function AddButton({ disabled = false }: { disabled?: boolean }) {
  const t = useTranslations("stores");
  const content = (
    <>
      <PlusIcon width={18} height={18} /> {t("add")}
    </>
  );
  return disabled ? <Button disabled>{content}</Button> : <LinkButton href={`${STORES}/new`}>{content}</LinkButton>;
}

function StoreRow({ store }: { store: Store }) {
  const t = useTranslations("stores");
  return (
    <li className={employees.listItem}>
      <Link href={`${STORES}/${store.id}`} className={employees.person}>
        <StoreLogo store={store} />
        <span className={styles.rowText}>
          <span className={styles.name}>{store.name}</span>
          <span className={styles.muted}>
            {store.whatsapp_number ? <bdi dir="ltr">{formatWhatsapp(store.whatsapp_number)}</bdi> : t("noWhatsapp")}
          </span>
          <span>
            <StatusChip status={store.status} />
          </span>
        </span>
        <ChevronIcon className={employees.chevron} width={18} height={18} style={{ marginBlockStart: 14 }} />
      </Link>
    </li>
  );
}

/** Screens 76, 77, 96 and 100 to 102: the stores the signed-in user may see. */
export function StoresList() {
  const access = useStoreAccess();
  return <StoresLoader loadingFooter={access.manage ? <AddButton disabled /> : undefined}>{(ctx) => <Loaded stores={ctx.stores} />}</StoresLoader>;
}

function Loaded({ stores }: { stores: Store[] }) {
  const t = useTranslations("stores");
  const common = useTranslations("common");
  const me = useMe();
  const access = useStoreAccess();

  return (
    <Screen>
      <AppBar title={t("title")} subtitle={me.business.name} backHref="/more" backLabel={common("back")} />
      <ScreenBody>
        {access.manage ? null : (
          <Banner icon="lock">{t("agentNote")}</Banner>
        )}
        {stores.length === 0 ? (
          <Card className={styles.empty}>
            <div className={styles.emptyIcon}>
              <StoreIcon width={28} height={28} />
            </div>
            <h2 className={screenStyles.title}>{t("none.title")}</h2>
            <p className={screenStyles.muted}>{t("none.text")}</p>
          </Card>
        ) : (
        <section className={employees.group} aria-label={t("title")}>
          <h2 className={employees.groupLabel}>
            {t("title")} · <span>{stores.length}</span>
          </h2>
          <Card>
            <ul className={employees.list}>
              {stores.map((store) => (
                <StoreRow key={store.id} store={store} />
              ))}
            </ul>
          </Card>
        </section>
        )}
        {access.manage && stores.length === 1 ? (
          <Card className={styles.empty}>
            <div className={styles.emptyIcon}>
              <StoreIcon width={28} height={28} />
            </div>
            <h2 className={screenStyles.title}>{t("one.title")}</h2>
            <p className={screenStyles.muted}>{t("one.text")}</p>
          </Card>
        ) : null}
      </ScreenBody>
      {access.manage ? (
        <ScreenFooter>
          <AddButton />
        </ScreenFooter>
      ) : null}
    </Screen>
  );
}
