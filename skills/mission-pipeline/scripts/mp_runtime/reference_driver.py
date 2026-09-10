"""Interactive JSONL model-transport reference; no model SDK or shell tools.

Reads a controller packet on stdin and sends the operator's JSON response from
an explicitly named reply file. Useful for connecting an existing model client
that writes protocol responses; automated tests use their own scripted driver.
"""
import argparse
import json
import sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--responses", required=True)
    p.add_argument("--packets", required=True)
    args = p.parse_args()
    responses = json.loads(Path(args.responses).read_text(encoding="utf-8"))
    for response in responses:
        packet = json.loads(sys.stdin.buffer.readline().decode("utf-8"))
        with open(args.packets, "ab") as out:
            out.write(json.dumps(packet, ensure_ascii=True).encode("utf-8") + b"\n")
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
