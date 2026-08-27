from prisma import Prisma

db = Prisma()


async def lock_project_version_sequence(transaction, project_id: str) -> None:
    """Serialize version-number allocation for one project within a transaction."""
    # The advisory-lock function returns PostgreSQL's pseudo-type `void`.
    # Use the non-returning raw API so Prisma does not try to deserialize it.
    await transaction.execute_raw(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        project_id,
    )
