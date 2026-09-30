"""Path identity is distinct from display and execution-platform mapping."""
import base64
import hashlib
import os
import contextlib
from pathlib import Path, PurePosixPath, PureWindowsPath

from .process import RuntimeRefusal, git_bytes, git_text, json_bytes


@contextlib.contextmanager
def execution_directory(path):
    """CreateProcess's cwd is MAX_PATH-limited even with an extended file path.

    A private NTFS junction gives the child a short spelling of the exact same
    directory. No shell, global drive mapping, or copied environment is used.
    """
    if path is None or os.name != "nt" or len(str(display_path(path))) < 220:
        yield str(display_path(path)) if path is not None else None
        return
    import ctypes
    import struct
    import tempfile
    target = str(display_path(path).resolve())
    if target.startswith("\\\\"):
        raise RuntimeRefusal("UNSUPPORTED_EXECUTION_ROOT", "Long network cwd requires a registered local execution root")
    with tempfile.TemporaryDirectory(prefix="mp-cwd-") as td:
        link = Path(td) / "root"
        link.mkdir()
        substitute = ("\\??\\" + target).encode("utf-16-le")
        printable = target.encode("utf-16-le")
        names = substitute + b"\0\0" + printable + b"\0\0"
        data = struct.pack("<IHHHHHH", 0xA0000003, 8 + len(names), 0, 0, len(substitute), len(substitute) + 2, len(printable)) + names
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.restype = ctypes.c_void_p
        handle = kernel.CreateFileW(str(link), 0x40000000, 0, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value:
            link.rmdir()
            raise RuntimeRefusal("EXECUTION_ROOT_UNAVAILABLE", "Cannot open private cwd junction", winerror=ctypes.get_last_error())
        try:
            returned = ctypes.c_ulong()
            buffer = ctypes.create_string_buffer(data)
            if not kernel.DeviceIoControl(ctypes.c_void_p(handle), 0x900A4, buffer, len(data), None, 0, ctypes.byref(returned), None):
                raise RuntimeRefusal("EXECUTION_ROOT_UNAVAILABLE", "Filesystem cannot create the required local cwd junction", winerror=ctypes.get_last_error())
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
        try:
            yield str(link)
        finally:
            # Remove the generated junction itself, never recurse into its target.
            link.rmdir()


def display_path(path):
    text = str(path)
    if os.name == "nt" and text.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + text[8:])
    if os.name == "nt" and text.startswith("\\\\?\\"):
        return Path(text[4:])
    return Path(path)


def io_path(path, force=False):
    """Use Win32 extended paths for filesystem calls, without changing logical identity."""
    path = Path(path).absolute()
    value = str(path)
    # Extend the root before appending children: temporary directories, SQLite
    # sidecars and UUID suffixes may cross MAX_PATH even when their parent does not.
    if os.name == "nt" and (force or len(value) >= 240) and not value.startswith("\\\\?\\"):
        value = "\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value
    return Path(value)


def relative_path(path, root):
    return display_path(path).relative_to(display_path(root))


def contained(path, root):
    try:
        display_path(path).resolve().relative_to(display_path(root).resolve())
        return True
    except (ValueError, OSError):
        return False


def root_identity(root):
    root = io_path(Path(root).resolve(), force=True)
    stat = root.stat()
    canonical = str(display_path(root))
    if os.name == "nt":
        canonical = canonical.casefold()
    identity = {"canonical_root": canonical, "device": stat.st_dev, "inode": stat.st_ino}
    try:
        common = Path(git_text(["rev-parse", "--git-common-dir"], root).strip())
        common = io_path(common if common.is_absolute() else root / common, force=True).resolve()
        common_stat = common.stat()
        common_path = str(display_path(common))
        identity["git_common"] = {"path": common_path.casefold() if os.name == "nt" else common_path, "device": common_stat.st_dev, "inode": common_stat.st_ino}
    except RuntimeRefusal as exc:
        if exc.code != "GIT_ERROR":
            raise
    return dict(identity, root_id=hashlib.sha256(json_bytes(identity)).hexdigest())


def resolve_ref(root, ref, must_exist=False, root_id=None):
    root = Path(root).resolve()
    if isinstance(ref, dict):
        if ref.get("root_id") is not None and ref["root_id"] != (root_id or root_identity(root)["root_id"]):
            raise RuntimeRefusal("ROOT_MAPPING_MISMATCH", "PathRef belongs to a different registered execution root")
        parts = ref.get("relative_segments", [])
        if not isinstance(parts, list):
            raise RuntimeRefusal("INVALID_PATH", "PathRef relative_segments must be an array")
        if any(not isinstance(p, str) or p in ("", ".", "..") or "/" in p or "\0" in p
               or (os.name == "nt" and "\\" in p) for p in parts):
            raise RuntimeRefusal("INVALID_PATH", "Invalid relative path components")
        path = root.joinpath(*parts)
    else:
        if not isinstance(ref, str) or "\0" in ref:
            raise RuntimeRefusal("INVALID_PATH", "Expected path string or PathRef")
        # A Windows drive-relative path must never become a POSIX filename.
        win = PureWindowsPath(ref)
        if win.drive and not win.root:
            raise RuntimeRefusal("INVALID_PATH", "Drive-relative paths are ambiguous")
        if os.name != "nt" and win.drive:
            raise RuntimeRefusal("PATH_MAPPING_REQUIRED", "Register the Windows root with the WSL bridge")
        path = Path(ref)
        if not path.is_absolute():
            path = root / path
    path = path.resolve()
    if not contained(path, root):
        raise RuntimeRefusal("PATH_OUTSIDE_SCOPE", "Path escapes the registered root")
    if os.name == "nt":
        reserved = {"CON", "PRN", "AUX", "NUL"} | {"COM" + str(i) for i in range(1, 10)} | {"LPT" + str(i) for i in range(1, 10)}
        for part in relative_path(path, root).parts:
            if any(ord(c) < 32 or c in '<>:"|?*' for c in part) or part.endswith((" ", ".")) or part.split(".", 1)[0].upper() in reserved:
                raise RuntimeRefusal("UNREPRESENTABLE_PATH", "Path component cannot be represented losslessly on Windows")
    path = io_path(path)
    if must_exist and not path.exists():
        raise RuntimeRefusal("EVIDENCE_UNAVAILABLE", "Path does not exist", path=str(path))
    return path


def git_path(raw):
    return raw.decode("utf-8", "strict" if os.name == "nt" else "surrogateescape")


def source_manifest(tree, ledger=None):
    """Identity of the tree actually judged.

    A clean tracked file already has a content identity git computed when it was
    staged: the index blob id. Hash changed files and files whose working EOL
    differs from the index. Git can call a CRLF conversion clean even though the
    actual bytes differ; that conversion must remain visible in evidence identity.
    """
    tree = Path(tree).resolve()
    commit = git_text(["rev-parse", "--verify", "HEAD^{commit}"], tree).strip()
    status = git_bytes(["status", "--porcelain=v1", "-z"], tree).split(b"\0")
    reported, dirty, i = set(), False, 0
    while i < len(status):
        row = status[i]
        i += 1
        if not row:
            continue
        code, raw = row[:2], row[3:]
        try:
            rel = git_path(raw)
        except UnicodeError as exc:
            raise RuntimeRefusal("SOURCE_INCOMPLETE", "Git status path is not representable") from exc
        reported.add(raw)
        if not rel.startswith(".claude/") and not (ledger and contained(tree / rel, ledger)):
            dirty = True
        if b"R" in code or b"C" in code:
            # -z rename emits destination then original path; both are changed.
            if i < len(status):
                reported.add(status[i])
            i += 1
    index = []
    normalized = set()
    for row in git_bytes(["ls-files", "--eol", "-z"], tree).split(b"\0"):
        if not row:
            continue
        head, tab, raw = row.partition(b"\t")
        fields = head.split()
        if tab and len(fields) >= 2 and fields[0][2:] != fields[1][2:]:
            normalized.add(raw)
    for row in git_bytes(["ls-files", "-s", "-z"], tree).split(b"\0"):
        if not row:
            continue
        head, tab, raw = row.partition(b"\t")
        fields = head.split(b" ")
        if not tab or len(fields) != 3 or len(fields[1]) != 40:
            raise RuntimeRefusal("SOURCE_INCOMPLETE", "Git index entry is not representable",
                                 path_bytes=base64.b64encode(row).decode("ascii"))
        index.append((raw, fields[0], fields[1]))
    entries = []
    for raw, mode, blob in sorted(index):
        try:
            rel = git_path(raw)
            path = io_path(tree / rel)
            if rel.startswith(".claude/") or (ledger and contained(path, ledger)):
                continue
            kind = "symlink" if mode == b"120000" else "file"
            if raw not in reported and raw not in normalized:
                entry = {"path_b64": base64.b64encode(raw).decode("ascii"),
                         "git_blob": blob.decode("ascii"), "kind": kind}
            elif not path.exists() and not path.is_symlink():
                # A tracked deletion is an actual, reproducible source state.
                entry = {"path_b64": base64.b64encode(raw).decode("ascii"), "sha256": None, "kind": "deleted"}
            elif path.is_symlink():
                entry = {"path_b64": base64.b64encode(raw).decode("ascii"),
                         "sha256": hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest(), "kind": "symlink"}
            else:
                entry = {"path_b64": base64.b64encode(raw).decode("ascii"),
                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "kind": "file"}
        except (OSError, UnicodeError) as exc:
            raise RuntimeRefusal("SOURCE_INCOMPLETE", "Tracked source cannot be read losslessly",
                                 path_bytes=base64.b64encode(raw).decode("ascii")) from exc
        entries.append(entry)
    return {"identity_version": 3, "commit_sha": commit, "dirty": int(dirty),
            "tree_hash": hashlib.sha256(json_bytes(entries)).hexdigest(),
            "git_tree": None if dirty else git_text(["rev-parse", "HEAD^{tree}"], tree).strip(),
            "entries": entries, "complete": True}
