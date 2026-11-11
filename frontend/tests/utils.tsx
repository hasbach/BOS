import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";

import ar from "../messages/ar.json";
import en from "../messages/en.json";

const catalogs = { en, ar };

export function renderWithIntl(ui: ReactElement, locale: "en" | "ar" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]}>
      {ui}
    </NextIntlClientProvider>,
  );
}

export { en, ar };
