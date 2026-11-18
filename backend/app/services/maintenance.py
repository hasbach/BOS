"""Per-business maintenance steps run by ``flask bos maintenance`` (R50, R24, R45).

Businesses are listed in one short transaction in operator context
(``app.core.tenancy.enter_operator``; policy ``operator_reads_tenants`` on ``tenants``), then
each business is handled in its own ``tenant_transaction``, never through
``enter_tenant_from_operator`` (which stays reserved to onboarding and the demo seed).

Step: delete staged product photos past their 24-hour expiry, then their files. Files are
deleted only after that business's transaction has committed, so a rolled-back step never
loses a file still referenced. A business whose step fails is rolled back and reported; the
other businesses are still processed.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from sqlalchemy import Engine, text

from app.core.storage import Storage
from app.core.tenancy import operator_transaction, tenant_transaction
from app.services import photos

log = logging.getLogger("bos.maintenance")


@dataclass
class TenantMaintenance:
    staged_photos_deleted: int = 0
    failed: list[uuid.UUID] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {"staged_photos_deleted": self.staged_photos_deleted}


def tenant_ids(engine: Engine) -> list[uuid.UUID]:
    with operator_transaction(engine) as db:
        return list(db.execute(text("SELECT id FROM tenants ORDER BY id")).scalars())


def run_tenant_steps(engine: Engine, storage: Storage) -> TenantMaintenance:
    result = TenantMaintenance()
    for tenant_id in tenant_ids(engine):
        try:
            with tenant_transaction(engine, tenant_id) as db:
                purged = photos.purge_staged(db)
        except Exception:
            log.exception("maintenance failed for one business; it was rolled back")
            result.failed.append(tenant_id)
            continue
        # Committed: now the files can go.
        for path in purged.paths:
            try:
                storage.delete(path)
            except Exception:
                log.exception("could not delete a purged photo file")
        result.staged_photos_deleted += purged.photos
    return result
