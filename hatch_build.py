"""Wheel build hook: pull providers/ into the wheel under kijito_tools/_assets/, minus maintainer material.

providers/ is walked WHOLESALE (never enumerated per provider; see pyproject.toml) and each file is
force-included, except the paths in PAYLOAD_EXCLUDE. A static `force-include` of the directory
cannot do this: hatch's `exclude` does not apply to force-included paths (measured 2026-10-05).

PAYLOAD_EXCLUDE (M459): the Codex provider's tests, plans, N0 probe harness and plan documents are
maintainer material that no installer runs. The installer's hash-gated set (wake-helper/ and
../_shared/wake-core.mjs) is untouched. Mirrored in package.json files[] and the sdist exclude;
CI asserts all three built payloads.
"""
from fnmatch import fnmatch
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

PAYLOAD_EXCLUDE = (
    "providers/codex/test/*",
    "providers/codex/plans/*",
    "providers/codex/n0-harness/*",
    "providers/codex/*plan*.md",
    "providers/codex/n0-capability-probe-protocol.md",
)


def excluded(rel: str) -> bool:
    return any(fnmatch(rel, pat) for pat in PAYLOAD_EXCLUDE)


class ProviderAssetsHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version, build_data):
        root = Path(self.root)
        for path in sorted((root / "providers").rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            if "__pycache__" in rel.split("/") or excluded(rel):
                continue
            build_data["force_include"][str(path)] = f"kijito_tools/_assets/{rel}"
