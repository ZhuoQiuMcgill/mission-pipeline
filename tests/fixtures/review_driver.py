"""Deterministic role transport exercising real packets, reads and submissions."""
import base64
import json
import sys

packet = json.loads(sys.stdin.buffer.readline())["packet"]
config = json.loads(sys.argv[1])
def exchange(call):
    print(json.dumps({"tool_calls": [call]}), flush=True)
    return json.loads(sys.stdin.buffer.readline())["tool_results"][0]


def read_inputs(packet):
    for start in range(0, len(packet["input_manifest"]), 32):
        result = exchange({"tool": "read_blobs", "blobs": packet["input_manifest"][start:start + 32]})
        assert result["ok"], result
        for item in result["result"]["blobs"]:
            assert isinstance(base64.b64decode(item["base64"]), bytes)


read_inputs(packet)
if config.pop("rebase", False):
    result = exchange({"tool": "submit", "request": {"action": "review.rebase",
        "request_id": config["request_id"] + "-explicit-rebase", "data": {"case": config["case"]}}})
    assert result["ok"], result
    packet = exchange({"tool": "refresh_packet"})["result"]
    read_inputs(packet)
case = next(r["object"] for r in packet["records"] if r["kind"] == "case" and r["object"]["id"] == config["case"])
data = dict(config, source_blob=case["source_blob"])
request_id = data.pop("request_id")
action = data.pop("action", "contest.decide")
print(json.dumps({"tool_calls": [{"tool": "submit", "request": {
    "action": action, "request_id": request_id, "data": data}}]}), flush=True)
result = json.loads(sys.stdin.buffer.readline())["tool_results"][0]
print(json.dumps({"final_document": json.dumps(result)}), flush=True)
