"""A minimal Python client for theloop: one run, streamed over SSE, usage at the end.

    terminal 1:  npm run dev                 # the engine, per the README quickstart
    terminal 2:  pip install httpx
                 ENGINE_TOKEN=... python client.py "Hello!"

The only dependency is httpx. The script holds ENGINE_TOKEN, so it runs on the harness
side (SPEC §4.1); an end-user client would only ever hold stream_url with the run token.

Without callback.url the contract allows only wait: true, and such a response arrives
after the run ends (SPEC §7). The same workaround as scripts/sse-check.ts (SPEC §11.2):
the run is started by a background request with an idempotency_key, and a repeat with
the same key and body returns the stream_url of the running run at once. The stream is
followed live; if it drops, the client reconnects with Last-Event-ID (SPEC §6.6).
"""

import asyncio
import json
import os
import sys
import uuid

import httpx

ENGINE_URL = os.environ.get("ENGINE_URL", "http://localhost:8080").rstrip("/")
ENGINE_TOKEN = os.environ.get("ENGINE_TOKEN", "")
PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic")
MODEL = os.environ.get("LLM_MODEL", "claude-sonnet-5")


def run_body(prompt: str) -> dict:
    llm: dict = {"provider": PROVIDER, "model": MODEL}
    # without api_key the engine uses its own env key, and only with a built-in base_url (SPEC §9.1)
    if os.environ.get("LLM_API_KEY"):
        llm["api_key"] = os.environ["LLM_API_KEY"]
    if os.environ.get("LLM_BASE_URL"):
        llm["base_url"] = os.environ["LLM_BASE_URL"]
    return {
        "contract_version": "1",
        "idempotency_key": f"python-client-{uuid.uuid4()}",
        "llm": llm,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        "limits": {"max_steps": 2, "max_tokens": 1024, "timeout_ms": 120_000},
        "wait": True,
    }


async def post_run(client: httpx.AsyncClient, body: dict) -> dict:
    """POST /runs; returns the start body (run_id, stream_url) or the result (wait: true)."""
    res = await client.post(
        "/runs",
        json=body,
        headers={"Authorization": f"Bearer {ENGINE_TOKEN}"},
    )
    if res.status_code not in (200, 202):
        detail = res.json().get("error", res.text)
        raise RuntimeError(f"POST /runs: HTTP {res.status_code}: {detail}")
    return res.json()


async def sse_events(res: httpx.Response):
    """Yields (event, data) pairs; comments (`: ping`) and blank-line framing per SSE."""
    event: str | None = None
    data: list[str] = []
    async for line in res.aiter_lines():
        if not line:
            if event is not None:
                yield event, "\n".join(data)
            event, data = None, []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            chunk = line[len("data:"):]
            data.append(chunk[1:] if chunk.startswith(" ") else chunk)
        elif line.startswith("id:"):  # takes effect at once, not on the blank line (SSE spec)
            yield "id", line[len("id:"):].strip()
    if event is not None:
        yield event, "\n".join(data)


async def follow_stream(client: httpx.AsyncClient, stream_url: str) -> dict | None:
    """Prints the run as it goes; returns the `done` payload, or None if the stream failed."""
    last_id = None
    for _ in range(3):  # a dropped stream reconnects with Last-Event-ID (SPEC §6.6)
        headers = {"Accept": "text/event-stream"}
        if last_id:
            headers["Last-Event-ID"] = last_id
        try:
            async with client.stream("GET", stream_url, headers=headers) as res:
                if res.status_code != 200:
                    body = (await res.aread()).decode(errors="replace")
                    print(f"stream: HTTP {res.status_code}: {body}", file=sys.stderr)
                    return None
                async for event, data in sse_events(res):
                    if event == "id":
                        last_id = data
                        continue
                    payload = json.loads(data) if data else {}
                    if event == "start":
                        print(f"model {payload.get('provider')}/{payload.get('model')}")
                    elif event == "delta":
                        print(payload.get("text", ""), end="", flush=True)
                    elif event == "snapshot" and payload.get("text"):
                        print(payload["text"], end="", flush=True)
                    elif event == "tool_call":
                        print(f"\n[{payload.get('tool')}]\n", end="", flush=True)
                    elif event == "llm_fallback":
                        to = payload.get("to", {})
                        print(f"\n[fallback to {to.get('provider')}/{to.get('model')}]\n", end="", flush=True)
                    elif event == "done":
                        return payload
        except httpx.HTTPError as err:
            print(f"\nstream interrupted: {err!r}", file=sys.stderr)
        print("reconnecting with Last-Event-ID ...", file=sys.stderr)
    return None


def print_usage(usage: dict) -> None:
    total = usage.get("total", {})
    counts = [
        f"{total.get('input_tokens', 0)} input",
        f"{total.get('output_tokens', 0)} output",
        f"{total.get('cache_read_tokens', 0)} cache read",
        f"{total.get('cache_write_tokens', 0)} cache write",
        f"{total.get('reasoning_tokens', 0)} reasoning",
    ]
    estimated = ", estimated" if total.get("estimated") else ""
    print(f"usage: {', '.join(counts)} tokens; "
          f"{total.get('calls', 0)} calls ({total.get('unknown_calls', 0)} unknown){estimated}")
    cost = usage.get("cost")
    if cost:
        print(f"cost: {cost.get('amount')} {cost.get('currency', '')}".strip())


def print_result(payload: dict) -> int:
    status = payload.get("status")
    print(f"\nstatus: {status} (finish_reason: {payload.get('finish_reason')})")
    error = payload.get("error")
    if error:
        print(f"error: {error.get('code')}: {error.get('message')}", file=sys.stderr)
    timing = payload.get("timing")
    if timing:
        print(f"timing: {timing.get('duration_ms')} ms, {timing.get('steps')} steps")
    usage = payload.get("usage")
    if usage:
        print_usage(usage)
    return 0 if status == "completed" else 1


async def main() -> int:
    if not ENGINE_TOKEN:
        print("ENGINE_TOKEN is required — the same value the engine uses", file=sys.stderr)
        return 2
    prompt = " ".join(sys.argv[1:]).strip() or "Hello!"
    body = run_body(prompt)

    async with httpx.AsyncClient(base_url=ENGINE_URL, timeout=httpx.Timeout(180.0)) as client:
        # the background POST carries the run to the end and returns the full result (SPEC §7)
        result_task = asyncio.create_task(post_run(client, body))
        await asyncio.sleep(0.3)  # let the run register, then fetch its stream_url (SPEC §11.2)
        try:
            start = await post_run(client, body)
        except RuntimeError as err:
            # a configuration error surfaces on both requests; the first carries the real status
            result_task.cancel()
            print(str(err), file=sys.stderr)
            return 2
        run_id = start.get("run_id")
        stream_url = start.get("stream_url")
        if run_id:
            print(f"run {run_id}")
        if not stream_url:
            result = await result_task
            print("no stream_url in the response; from the result body:")
            return print_result(result)

        done = await follow_stream(client, stream_url)
        result = await result_task  # the authoritative result: status, usage, timing (SPEC §7)
        if done is None:
            print("stream lost; from the result body:")
            return print_result(result)
        # the done event carries no timing (SPEC §6.6); the result body does (SPEC §7)
        return print_result({**result, **done})


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
