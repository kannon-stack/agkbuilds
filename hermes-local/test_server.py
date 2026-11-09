#!/usr/bin/env python3
"""Protocol checks for the local server (stdlib only).

Verifies what Hermes Agent depends on: structured tool_calls (streaming and
not), a tool-result round trip with assistant ``content: null``, and plain
chat. Usage:  python3 test_server.py [base_url]   (default http://127.0.0.1:8080/v1)
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/v1"
TOOLS = [{"type": "function", "function": {
    "name": "get_weather", "description": "Get current weather for a city",
    "parameters": {"type": "object", "properties": {"city": {"type": "string"},
                                                    "days": {"type": "integer"}},
                   "required": ["city"]}}}]
ASK = [{"role": "system", "content": "You are a helpful assistant."},
       {"role": "user", "content": "What is the weather in Paris? Use the tool."}]


def post(payload, stream=False):
    req = urllib.request.Request(BASE + "/chat/completions", json.dumps(payload).encode(),
                                 {"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req, timeout=3600)
    if not stream:
        return json.load(resp)
    calls, content, finish = {}, "", None
    for line in resp:
        line = line.decode().strip()
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        ch = json.loads(line[6:])["choices"]
        if not ch:
            continue
        d = ch[0]["delta"]
        content += d.get("content") or ""
        for tc in d.get("tool_calls") or []:
            c = calls.setdefault(tc["index"], {"name": "", "arguments": ""})
            c["name"] += tc["function"].get("name") or ""
            c["arguments"] += tc["function"].get("arguments") or ""
        finish = ch[0].get("finish_reason") or finish
    return {"content": content, "calls": list(calls.values()), "finish": finish}


def check(name, cond, detail):
    print(("PASS " if cond else "FAIL ") + name + ": " + json.dumps(detail)[:300])
    return cond


ok = True
t = time.time()
r = post({"model": "x", "messages": ASK, "tools": TOOLS, "tool_choice": "auto"})
m = r["choices"][0]["message"]
calls = m.get("tool_calls") or []
args = json.loads(calls[0]["function"]["arguments"]) if calls else {}
ok &= check("non-stream tool call", calls and calls[0]["function"]["name"] == "get_weather"
            and "paris" in str(args.get("city", "")).lower()
            and r["choices"][0]["finish_reason"] == "tool_calls", m)
print(f"     ({time.time() - t:.1f}s, usage={r.get('usage')})")

t = time.time()
s = post({"model": "x", "messages": ASK, "tools": TOOLS, "stream": True}, stream=True)
ok &= check("stream tool call", s["calls"] and s["calls"][0]["name"] == "get_weather"
            and s["finish"] == "tool_calls" and "<tool_call>" not in s["content"], s)
print(f"     ({time.time() - t:.1f}s)")

t = time.time()
follow = ASK + [{"role": "assistant", "content": None, "tool_calls": [{"id": "call_1", "type": "function",
                 "function": {"name": "get_weather", "arguments": "{\"city\": \"Paris\"}"}}]},
                {"role": "tool", "tool_call_id": "call_1",
                 "content": "{\"temp_c\": 14, \"conditions\": \"light rain\"}"}]
r = post({"model": "x", "messages": follow, "tools": TOOLS})
m = r["choices"][0]["message"]
ok &= check("tool result round trip", (m.get("content") or "") and "14" in m["content"]
            and not m.get("tool_calls"), m)
print(f"     ({time.time() - t:.1f}s, usage={r.get('usage')})")

t = time.time()
s = post({"model": "x", "stream": True, "messages": [
    {"role": "user", "content": "Reply with exactly the word: pong"}]}, stream=True)
ok &= check("plain streamed chat", "pong" in s["content"].lower() and s["finish"] == "stop", s)
print(f"     ({time.time() - t:.1f}s)")

print("ALL PASSED" if ok else "SOME CHECKS FAILED")
sys.exit(0 if ok else 1)
