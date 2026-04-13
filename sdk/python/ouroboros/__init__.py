# ==============================================================================
# OpenSIN Component: __init__.py
# ==============================================================================
# DESCRIPTION: Package initializer for the Ouroboros SDK.
# WHY: Exposes the stable public API used by tests, hooks, and agent runtimes.
# CONSEQUENCES: Import sites stay clean and do not need to know internal paths.
# AUTHOR: SIN-Zeus
# ==============================================================================

from .memory import OuroborosDNA, default_ouroboros_db_path

__all__ = ["OuroborosDNA", "default_ouroboros_db_path"]
