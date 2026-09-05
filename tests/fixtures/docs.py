"""The document contract, as files.

Every fixture in this directory is a complete, contract-conformant artifact with
`$placeholders` for the parts a mission fills in. They are the reference
implementation of the DOCUMENT CONTRACT that `mp seal` parses: if a template
here and the engine disagree, one of them is wrong and the tests say so.

    from docs import render, write
"""
import string
from pathlib import Path

FIX = Path(__file__).resolve().parent

# Optional slots: a caller that says nothing about them gets an empty line,
# never a literal `$placeholder` in a sealed document.
DEFAULTS = {
    "extra_header": "",   # Charter: optional `branch:` / `cap:` header lines
    "audit": "- None",    # MissionClose: the ClosureAudit, when one is required
    "acceptance": "",     # MissionClose: the principal's verbatim words
    "delegation": "",     # MissionClose: the delegating standing contract
    "outcome_text": "the mission delivered what its Charter asked for",
    "relay": "",
    "cell_criteria": "",  # CalibrationVerdict: an optional criteria table
}

def render(name, **kw):
    text = (FIX / f"{name}.md").read_text(encoding="utf-8")
    fields = dict(DEFAULTS)
    fields.update(kw)
    return string.Template(text).safe_substitute(**fields)

def write(root, relpath, name, **kw):
    """Render a fixture into <root>/<relpath> and return the absolute path."""
    p = Path(root) / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(render(name, **kw), encoding="utf-8")
    return p
