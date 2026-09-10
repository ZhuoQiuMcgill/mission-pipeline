"""Source-faithful Markdown fields with immutable byte and line provenance."""
import re

from .process import RuntimeRefusal

ITEM = re.compile(r"^(\s*)([-+*]|\d+[.)])\s+(.*)$")


def text_snapshot(raw):
    try:
        return raw.decode("utf-8-sig")
    except UnicodeError as exc:
        raise RuntimeRefusal("INVALID_UTF8", "Document is not valid UTF-8; original bytes are retained") from exc


def list_items(lines, start_line=1):
    """Collect complete top-level items, including continuations and fences."""
    result, current, base, fence = [], None, None, None
    for index, line in enumerate(lines, start_line):
        stripped = line.lstrip()
        marker = re.match(r"(`{3,}|~{3,})", stripped)
        match = ITEM.match(line) if not fence else None
        if match and (base is None or len(match[1]) <= base):
            if current:
                result.append(current)
            base = len(match[1])
            current = {"start_line": index, "end_line": index, "raw_lines": [line], "first": match[3]}
        elif current:
            current["raw_lines"].append(line)
            current["end_line"] = index
        if marker:
            token = marker[1][0]
            if fence is None:
                fence = token
            elif fence == token:
                fence = None
    if current:
        result.append(current)
    for item in result:
        item["raw_text"] = "\n".join(item.pop("raw_lines")).rstrip()
        tail = item["raw_text"].splitlines()[1:]
        item["text"] = "\n".join([item.pop("first")] + tail).rstrip()
    return result


def validate_single(items):
    if len(items) > 1:
        raise RuntimeRefusal("MULTIPLE_SINGLE_ITEMS", "This field allows one complete risk, not several silently truncated items")
    return items


def validate_none(items):
    absent = [x for x in items if re.fullmatch(r"(?i)[*_ ]*none[.*_ ]*", x["text"].strip())]
    if absent and len(items) != 1:
        raise RuntimeRefusal("MIXED_NONE", "None cannot be mixed with actual items")
    return [] if absent else items


def cells(line):
    if not line.strip().startswith("|"):
        return None
    # Escaped pipes remain literal data; actual cells are preserved in raw_text.
    return [re.sub(r"\\\|", "|", x.strip()) for x in re.split(r"(?<!\\)\|", line.strip().strip("|"))]


def criteria_rows(raw, legacy=False):
    lines = text_snapshot(raw).splitlines()
    rows, active, last = [], False, None
    for number, line in enumerate(lines, 1):
        row = cells(line)
        if row and len(row) >= 5 and row[0] == "#" and "criterion" in row[1].lower():
            active = True
            continue
        if not active:
            continue
        if row is None:
            if line.strip():
                active = False
            continue
        if all(re.fullmatch(r"[:\- ]*", cell) for cell in row):
            continue
        if len(row) < 5:
            raise RuntimeRefusal("INVALID_CRITERIA", "Criteria table row needs five cells", line=number)
        id = row[0] or last
        last = id
        met = row[2].strip("*_ ").split(" ")[0].lower()
        if not id or met not in ("met", "partial", "missed"):
            raise RuntimeRefusal("INVALID_CRITERIA", "Criterion id and valid per-row status are required", line=number)
        rows.append(dict(id=id, criterion=row[1], met=met, anchor=row[3], type=row[4],
                         source_line=number, raw_text=line))
    grouped, rank = {}, {"met": 2, "partial": 1, "missed": 0}
    for row in rows:
        group = grouped.setdefault(row["id"], {"rows": [], "conflict": False})
        if group["rows"]:
            first = group["rows"][0]
            conflict = row["met"] != first["met"] or bool(row["criterion"] and first["criterion"] and row["criterion"] != first["criterion"])
            group["conflict"] |= conflict
            if conflict and not legacy:
                raise RuntimeRefusal("CONFLICTING_CRITERION", "Use explicit sub-ids for different criterion text or status",
                                     criterion=row["id"], line=row["source_line"])
        group["rows"].append(row)
        group["met"] = min((x["met"] for x in group["rows"]), key=rank.get)
    return {"rows": rows, "criteria": grouped, "eligible": not any(g["conflict"] for g in grouped.values())}


def sections(raw):
    result, name, items = {}, None, []
    fence = None
    for index, line in enumerate(text_snapshot(raw).splitlines(), 1):
        marker = re.match(r"^\s*(`{3,}|~{3,})", line)
        if marker:
            token = marker[1][0]
            fence = None if fence == token else token
        if line.startswith("## ") and not fence:
            if name is not None:
                result[name] = items
            name, items = line[3:].strip(), []
        elif name is not None:
            items.append((index, line))
    if name is not None:
        result[name] = items
    return result


def document_fields(raw, legacy=False):
    result = {"criteria": criteria_rows(raw, legacy=legacy), "lists": {}}
    for name, rows in sections(raw).items():
        if any(term in name.lower() for term in ("risk", "noticed", "relay", "engine", "out-of-frame")):
            parsed = list_items([row[1] for row in rows], rows[0][0] if rows else 1)
            if not legacy:
                parsed = validate_none(parsed)
                if "risk" in name.lower() and "risks" not in name.lower():
                    validate_single(parsed)
            result["lists"][name] = parsed
    return result
