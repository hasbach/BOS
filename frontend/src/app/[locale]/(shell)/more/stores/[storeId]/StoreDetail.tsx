"use client";

import { NotFoundScreen, StoresLoader } from "../parts";
import { StoreEditor } from "./StoreEditor";

/** Screens 83 to 90, 97 and 102: one store, found in the list the user is allowed to see. */
export function StoreDetail({ storeId }: { storeId: string }) {
  return (
    <StoresLoader>
      {(ctx) => {
        const store = ctx.stores.find((candidate) => candidate.id === storeId);
        return store ? <StoreEditor key={store.id} store={store} /> : <NotFoundScreen />;
      }}
    </StoresLoader>
  );
}
