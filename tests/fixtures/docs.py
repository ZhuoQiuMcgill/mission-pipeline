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

def render(name, **kw):
    text = (FIX / f"{name}.md").read_text(encoding="utf-8")
    return string.Template(text).safe_substitute(**kw)

def write(root, relpath, name, **kw):
    """Render a fixture into <root>/<relpath> and return the absolute path."""
    p = Path(root) / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(render(name, **kw), encoding="utf-8")
    return p
