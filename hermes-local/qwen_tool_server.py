#!/usr/bin/env python3
"""Minimal OpenAI-compatible chat server for Qwen3.5 GGUF models on CPU.

Why this exists
---------------
Hermes Agent talks to a local model through OpenAI Chat Completions and needs
*structured* ``tool_calls`` back. llama-cpp-python's bundled server cannot do
that for Qwen3.5: its ``chatml-function-calling`` handler drops tool
descriptions and tool results, and it refuses streaming with tools. This
server instead:

* renders the model's own Jinja chat template (embedded in the GGUF), so the
  model sees tools and ``role: tool`` results exactly as it was trained;
* parses Qwen's XML tool-call output
  (``<tool_call><function=NAME><parameter=ARG>VALUE</parameter>...``) into
  OpenAI ``tool_calls`` with JSON-string arguments;
* streams (SSE) or answers in one response, and sends SSE keepalive comments
  while a long prompt is being prefilled on the CPU;
* keeps per-sequence state checkpoints. Qwen3.5 is a hybrid recurrent model, so
  llama.cpp cannot trim its cache back to a shared prefix; instead we snapshot
  the state at the end of each prompt (and at the end of the tools block) and
  restore the longest snapshot that is an exact prefix of the next prompt.
  Agent turns then only prefill the new tokens.
* exposes ``/props`` (llama.cpp style) and ``/v1/models`` with the real context
  length so Hermes detects the window correctly.

It serves one request at a time (one slot), which is what a 4-core CPU can do.

Run:  /opt/llm-venv/bin/python qwen_tool_server.py --model /root/models/Qwen3.5-4B-Q4_K_M.gguf --alias qwen3.5-4b
"""
from __future__ import annotations

import argparse
import ctypes
import json
import logging
import queue
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

import jinja2
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from jinja2.sandbox import ImmutableSandboxedEnvironment

import llama_cpp
from llama_cpp import Llama

log = logging.getLogger("qwen_tool_server")

TOOLS_BLOCK_END = "</IMPORTANT>"  # end of the tools preamble in the Qwen3.5 template
HOLD_TAGS = ("<tool_call>", "<function=", "<think>", "</think>")


# --------------------------------------------------------------------------- #
# Template rendering
# --------------------------------------------------------------------------- #
def _raise(msg: str):
    raise jinja2.TemplateError(msg)


def _tojson(value, indent=None, separators=None, sort_keys=False, ensure_ascii=False):
    return json.dumps(value, indent=indent, separators=separators,
                      sort_keys=sort_keys, ensure_ascii=ensure_ascii)


def build_template(source: str) -> jinja2.Template:
    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True,
                                        extensions=["jinja2.ext.loopcontrols"])
    env.filters["tojson"] = _tojson
    env.globals["raise_exception"] = _raise
    return env.from_string(source)


def _text_of(content: Any) -> Any:
    """Normalize OpenAI message content for the template."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append({"type": "text", "text": item.get("text", "")})
            elif isinstance(item, dict) and item.get("type") in ("image_url", "image", "input_image"):
                parts.append({"type": "text", "text": "[image omitted: this local model has no vision]"})
            elif isinstance(item, str):
                parts.append({"type": "text", "text": item})
        return parts
    return str(content)


def normalize_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    for i, m in enumerate(messages):
        role = m.get("role", "user")
        if role == "developer":
            role = "system"
        msg: dict[str, Any] = {"role": role, "content": _text_of(m.get("content"))}
        if role == "system" and out:
            # The Qwen template only accepts a system message at position 0.
            msg = {"role": "user", "content": "[System note]\n" + _flatten(msg["content"])}
        if role == "assistant":
            if isinstance(m.get("reasoning_content"), str):
                msg["reasoning_content"] = m["reasoning_content"]
            calls = []
            for tc in m.get("tool_calls") or []:
                fn = (tc or {}).get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args.strip() else {}
                    except json.JSONDecodeError:
                        args = {"input": args}
                if not isinstance(args, dict):
                    args = {"input": args}
                calls.append({"id": tc.get("id"), "type": "function",
                              "function": {"name": fn.get("name", ""), "arguments": args}})
            if calls:
                msg["tool_calls"] = calls
        if role == "tool":
            msg["content"] = _flatten(msg["content"])
        out.append(msg)
    return out


def _flatten(content: Any) -> str:
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


# --------------------------------------------------------------------------- #
# Tool-call parsing
# --------------------------------------------------------------------------- #
_CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|$)", re.S)
_FUNC_RE = re.compile(r"<function=([^>\s]+)\s*>(.*?)(?:</function>|$)", re.S)
_PARAM_RE = re.compile(r"<parameter=([^>\s]+)\s*>\n?(.*?)\n?</parameter>", re.S)


def _param_types(tools: Optional[list[dict]]) -> dict[str, dict[str, str]]:
    types: dict[str, dict[str, str]] = {}
    for t in tools or []:
        fn = t.get("function", t)
        props = ((fn.get("parameters") or {}).get("properties") or {})
        types[fn.get("name", "")] = {k: (v or {}).get("type", "") for k, v in props.items()
                                     if isinstance(v, dict)}
    return types


def _coerce(raw: str, typ: Any) -> Any:
    if typ == "string" or (isinstance(typ, list) and "string" in typ and len(typ) == 1):
        return raw
    s = raw.strip()
    if typ in ("", None) and not re.match(r'^[\[{"\-0-9]|^(true|false|null)$', s):
        return raw
    try:
        return json.loads(s)
    except (json.JSONDecodeError, ValueError):
        return raw


def parse_output(text: str, tools: Optional[list[dict]]):
    """Return (reasoning, content, tool_calls) from raw model text."""
    reasoning = None
    if "</think>" in text:
        head, text = text.split("</think>", 1)
        reasoning = head.replace("<think>", "").strip() or None
    text = text.lstrip("\n")
    idx = [i for i in (text.find("<tool_call>"), text.find("<function=")) if i >= 0]
    if not tools or not idx:
        return reasoning, text.strip(), []
    start = min(idx)
    content, tail = text[:start].strip(), text[start:]
    blocks = _CALL_RE.findall(tail) or [tail]
    ptypes = _param_types(tools)
    calls = []
    for block in blocks:
        for name, body in _FUNC_RE.findall(block):
            args = {k: _coerce(v, ptypes.get(name, {}).get(k)) for k, v in _PARAM_RE.findall(body)}
            calls.append({"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                          "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}})
    if not calls:  # malformed: hand the text back rather than lose it
        return reasoning, text.strip(), []
    return reasoning, content, calls


# --------------------------------------------------------------------------- #
# Engine: model + checkpoints + generation
# --------------------------------------------------------------------------- #
@dataclass
class Checkpoint:
    tokens: list[int]
    state: bytes
    kind: str
    used: float = field(default_factory=time.time)


class ContextOverflow(Exception):
    pass


class Engine:
    def __init__(self, args):
        self.args = args
        log.info("loading %s (n_ctx=%d, threads=%d)", args.model, args.n_ctx, args.threads)
        self.llm = Llama(
            model_path=args.model, n_ctx=args.n_ctx, n_batch=args.batch, n_ubatch=args.batch,
            n_threads=args.threads, n_threads_batch=args.threads, n_gpu_layers=0,
            flash_attn=True, type_k=args.kv_type, type_v=args.kv_type,
            logits_all=False, verbose=False,
        )
        tmpl = self.llm.metadata.get("tokenizer.chat_template")
        if not tmpl:
            raise SystemExit("GGUF has no tokenizer.chat_template")
        self.template_source = tmpl
        self.template = build_template(tmpl)
        self.stop_ids = {self.llm.token_eos()}
        for s in ("<|im_end|>", "<|endoftext|>"):
            ids = self.llm.tokenize(s.encode(), add_bos=False, special=True)
            if len(ids) == 1:
                self.stop_ids.add(ids[0])
        self.lock = threading.Lock()
        self.checkpoints: list[Checkpoint] = []
        self.ctx = self.llm._ctx.ctx  # raw llama_context*
        log.info("ready: stop ids %s", sorted(self.stop_ids))

    # -- state snapshots ---------------------------------------------------- #
    def _snapshot(self, tokens: list[int], kind: str):
        size = llama_cpp.llama_state_seq_get_size(self.ctx, 0)
        buf = (ctypes.c_uint8 * size)()
        n = llama_cpp.llama_state_seq_get_data(self.ctx, buf, size, 0)
        if not n:
            return
        self.checkpoints = [c for c in self.checkpoints if c.tokens != tokens]
        self.checkpoints.append(Checkpoint(list(tokens), bytes(buf)[:n], kind))
        for k, limit in (("tools", 2), ("turn", self.args.max_checkpoints)):
            same = sorted((c for c in self.checkpoints if c.kind == k), key=lambda c: c.used)
            for old in same[:-limit] if len(same) > limit else []:
                self.checkpoints.remove(old)
        log.info("checkpoint[%s] at %d tokens (%.0f MB, %d held)", kind, len(tokens),
                 n / 1e6, len(self.checkpoints))

    def _restore(self, prompt: list[int]) -> int:
        best = None
        for c in self.checkpoints:
            n = len(c.tokens)
            if n < len(prompt) and prompt[:n] == c.tokens and (best is None or n > len(best.tokens)):
                best = c
        self.llm.reset()
        if best is None:
            return 0
        data = (ctypes.c_uint8 * len(best.state)).from_buffer_copy(best.state)
        if not llama_cpp.llama_state_seq_set_data(self.ctx, data, len(best.state), 0):
            log.warning("checkpoint restore failed; full prefill")
            self.llm.reset()
            return 0
        n = len(best.tokens)
        self.llm.input_ids[:n] = best.tokens
        self.llm.n_tokens = n
        best.used = time.time()
        return n

    # -- prompt --------------------------------------------------------------- #
    def render(self, body: dict) -> tuple[str, Optional[list[dict]], bool]:
        tools = body.get("tools") or None
        if body.get("tool_choice") == "none":
            tools = None
        kwargs = body.get("chat_template_kwargs") or {}
        thinking = kwargs.get("enable_thinking", self.args.thinking)
        prompt = self.template.render(
            messages=normalize_messages(body.get("messages") or []), tools=tools,
            add_generation_prompt=True, enable_thinking=bool(thinking),
        )
        return prompt, tools, bool(thinking)

    # -- generation (runs in a worker thread, holds the lock) ----------------- #
    def generate(self, body: dict, events: "queue.Queue", cancel: threading.Event):
        try:
            with self.lock:
                self._generate(body, events, cancel)
        except ContextOverflow as e:
            events.put(("error", (400, str(e))))
        except jinja2.TemplateError as e:
            events.put(("error", (400, f"chat template error: {e}")))
        except Exception as e:  # noqa: BLE001
            log.exception("generation failed")
            events.put(("error", (500, f"{type(e).__name__}: {e}")))

    def _generate(self, body, events, cancel):
        t0 = time.time()
        prompt, tools, thinking = self.render(body)
        tokens = self.llm.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)
        n_ctx = self.args.n_ctx
        if len(tokens) >= n_ctx - 16:
            raise ContextOverflow(
                f"This model's maximum context length is {n_ctx} tokens. However, your messages "
                f"resulted in {len(tokens)} tokens. Please reduce the length of the messages.")
        events.put(("meta", {"tools": tools, "thinking": thinking}))

        start = self._restore(tokens)
        # Tools-block checkpoint: reusable across sessions with the same tool set.
        tools_cut = None
        if tools and TOOLS_BLOCK_END in prompt:
            pre = prompt[: prompt.index(TOOLS_BLOCK_END) + len(TOOLS_BLOCK_END)]
            pre_tok = self.llm.tokenize(pre.encode("utf-8"), add_bos=False, special=True)
            if tokens[: len(pre_tok)] == pre_tok and len(pre_tok) > start:
                tools_cut = len(pre_tok)

        body_end = len(tokens) - 1
        pos, chunk = start, self.args.batch * 2
        while pos < body_end:
            if cancel.is_set():
                return
            stop = min(body_end, pos + chunk)
            if tools_cut and pos < tools_cut <= stop:
                stop = tools_cut
            self.llm.eval(tokens[pos:stop])
            pos = stop
            if tools_cut and pos == tools_cut:
                self._snapshot(tokens[:pos], "tools")
            events.put(("progress", (pos, len(tokens))))
        if body_end - start > 64:
            self._snapshot(tokens[:body_end], "turn")
        self.llm.eval(tokens[body_end:])
        t_prefill = time.time() - t0
        log.info("prefill %d tokens (%d reused) in %.1fs", len(tokens) - start, start, t_prefill)

        g = lambda k, d: body.get(k) if body.get(k) is not None else d  # noqa: E731
        max_new = min(int(g("max_completion_tokens", g("max_tokens", n_ctx))), n_ctx - len(tokens) - 1)
        self.llm._sampler = self.llm._init_sampler(
            temp=float(g("temperature", self.args.temperature)),
            top_p=float(g("top_p", self.args.top_p)), top_k=int(g("top_k", self.args.top_k)),
            min_p=float(g("min_p", 0.0)), presence_penalty=float(g("presence_penalty", 0.0)),
            frequency_penalty=float(g("frequency_penalty", 0.0)),
            repeat_penalty=float(g("repeat_penalty", 1.0)),
        )
        stops = g("stop", None)
        stops = [stops] if isinstance(stops, str) else list(stops or [])
        out = bytearray()
        decoded = ""
        n_gen = 0
        finish = "length"
        try:
            for _ in range(max_new):
                if cancel.is_set():
                    return
                tok = self.llm.sample()
                if tok in self.stop_ids:
                    finish = "stop"
                    break
                n_gen += 1
                out += self.llm.detokenize([tok], special=False)
                text = out.decode("utf-8", errors="ignore")
                if len(text) > len(decoded):
                    events.put(("text", text[len(decoded):]))
                    decoded = text
                if stops and any(s in decoded for s in stops):
                    finish = "stop"
                    break
                self.llm.eval([tok])
        finally:
            self.llm._sampler = None
        dt = time.time() - t0 - t_prefill
        log.info("generated %d tokens in %.1fs (%.2f tok/s), finish=%s", n_gen, dt,
                 n_gen / dt if dt > 0 else 0, finish)
        events.put(("done", {"text": decoded, "finish": finish, "prompt_tokens": len(tokens),
                             "completion_tokens": n_gen, "cached_tokens": start}))


# --------------------------------------------------------------------------- #
# HTTP layer
# --------------------------------------------------------------------------- #
def create_app(engine: Engine) -> FastAPI:
    app = FastAPI(title="qwen-tool-server")
    alias, n_ctx = engine.args.alias, engine.args.n_ctx

    def model_card():
        return {"id": alias, "object": "model", "created": 0, "owned_by": "local",
                "context_length": n_ctx, "max_model_len": n_ctx}

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/v1/models")
    @app.get("/models")
    def models():
        return {"object": "list", "data": [model_card()]}

    @app.get("/props")
    @app.get("/v1/props")
    def props():
        return {"default_generation_settings": {"n_ctx": n_ctx}, "n_ctx": n_ctx,
                "total_slots": 1, "model_alias": alias, "model_path": engine.args.model,
                "chat_template": engine.template_source}

    @app.post("/v1/chat/completions")
    @app.post("/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        events: queue.Queue = queue.Queue()
        cancel = threading.Event()
        threading.Thread(target=engine.generate, args=(body, events, cancel), daemon=True).start()
        cid = "chatcmpl-" + uuid.uuid4().hex
        created = int(time.time())
        if body.get("stream"):
            include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
            return StreamingResponse(_sse(events, cancel, cid, created, alias, include_usage),
                                     media_type="text/event-stream")
        return _collect(events, cid, created, alias)

    return app


def _wait(events: queue.Queue, timeout: float):
    try:
        return events.get(timeout=timeout)
    except queue.Empty:
        return None


def _usage(done: dict) -> dict:
    return {"prompt_tokens": done["prompt_tokens"], "completion_tokens": done["completion_tokens"],
            "total_tokens": done["prompt_tokens"] + done["completion_tokens"],
            "prompt_tokens_details": {"cached_tokens": done["cached_tokens"]}}


def _collect(events, cid, created, alias):
    tools = None
    while True:
        ev = _wait(events, 3600)
        if ev is None:
            return JSONResponse({"error": {"message": "generation timed out"}}, status_code=504)
        kind, data = ev
        if kind == "meta":
            tools = data["tools"]
        elif kind == "error":
            code, msg = data
            return JSONResponse({"error": {"message": msg, "type": "invalid_request_error"
                                           if code == 400 else "server_error"}}, status_code=code)
        elif kind == "done":
            reasoning, content, calls = parse_output(data["text"], tools)
            msg: dict[str, Any] = {"role": "assistant", "content": content or None}
            if reasoning:
                msg["reasoning_content"] = reasoning
            if calls:
                msg["tool_calls"] = calls
            finish = "tool_calls" if calls else data["finish"]
            return {"id": cid, "object": "chat.completion", "created": created, "model": alias,
                    "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
                    "usage": _usage(data)}


def _chunk(cid, created, alias, delta, finish=None):
    return "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                  "model": alias, "choices": [{"index": 0, "delta": delta,
                                                               "finish_reason": finish}]},
                                 ensure_ascii=False) + "\n\n"


def _sse(events, cancel, cid, created, alias, include_usage) -> Iterator[str]:
    tools, thinking = None, False
    sent = 0          # chars of visible content already streamed
    raw = ""          # all generated text
    held = False      # once a tool call starts we stop streaming content
    try:
        yield _chunk(cid, created, alias, {"role": "assistant", "content": ""})
        while True:
            ev = _wait(events, 15)
            if ev is None:
                yield ": keepalive\n\n"  # prefill on CPU can take minutes
                continue
            kind, data = ev
            if kind == "meta":
                tools, thinking = data["tools"], data["thinking"]
            elif kind == "progress":
                yield f": prefill {data[0]}/{data[1]}\n\n"
            elif kind == "error":
                yield "data: " + json.dumps({"error": {"message": data[1]}}) + "\n\n"
                yield "data: [DONE]\n\n"
                return
            elif kind == "text":
                raw += data
                if held or thinking and "</think>" not in raw:
                    continue
                visible = raw.split("</think>", 1)[1].lstrip("\n") if "</think>" in raw else raw
                if tools:
                    cut = [i for i in (visible.find("<tool_call>"), visible.find("<function=")) if i >= 0]
                    if cut:
                        held = True
                        visible = visible[: min(cut)]
                    else:  # hold back a trailing partial tag such as "<tool_c"
                        lt = visible.rfind("<")
                        if lt >= 0 and any(t.startswith(visible[lt:]) for t in HOLD_TAGS):
                            visible = visible[:lt]
                if len(visible) > sent:
                    yield _chunk(cid, created, alias, {"content": visible[sent:]})
                    sent = len(visible)
            elif kind == "done":
                reasoning, content, calls = parse_output(data["text"], tools)
                if reasoning:
                    yield _chunk(cid, created, alias, {"reasoning_content": reasoning})
                if not calls and len(content) > sent:  # flush anything held back
                    yield _chunk(cid, created, alias, {"content": content[sent:]})
                for i, c in enumerate(calls):
                    yield _chunk(cid, created, alias, {"tool_calls": [{
                        "index": i, "id": c["id"], "type": "function",
                        "function": {"name": c["function"]["name"],
                                     "arguments": c["function"]["arguments"]}}]})
                yield _chunk(cid, created, alias, {}, "tool_calls" if calls else data["finish"])
                if include_usage:
                    yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk",
                                                 "created": created, "model": alias, "choices": [],
                                                 "usage": _usage(data)}) + "\n\n"
                yield "data: [DONE]\n\n"
                return
    finally:
        cancel.set()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", required=True)
    p.add_argument("--alias", default="local-model")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--n-ctx", type=int, default=65536)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--batch", type=int, default=512)
    p.add_argument("--kv-type", type=int, default=8, help="ggml type for K/V cache (8 = q8_0, 1 = f16)")
    p.add_argument("--max-checkpoints", type=int, default=3)
    p.add_argument("--thinking", action="store_true", help="enable Qwen thinking by default")
    p.add_argument("--temperature", type=float, default=0.7)
    p.add_argument("--top-p", type=float, default=0.8)
    p.add_argument("--top-k", type=int, default=20)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    engine = Engine(args)
    uvicorn.run(create_app(engine), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
