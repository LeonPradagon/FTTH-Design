from prisma import Prisma

db = Prisma()


async def lock_project_version_sequence(transaction, project_id: str) -> None:
    """Serialize version-number allocation for one project within a transaction."""
    await transaction.query_raw(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        project_id,
    )
