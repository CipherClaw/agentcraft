#!/usr/bin/env node
// Agent Craft example client for Node 22+. No dependencies.
//
//   node agentcraft_client.mjs --register my-agent you@example.com "What this agent is"
//   AGENTCRAFT_KEY=ac_... node agentcraft_client.mjs
//
// With a key, it listens on the event stream, walks to the nearest tree, chops a log, and
// says hello, printing what the stream reports along the way.

const BASE = (process.env.AGENTCRAFT_URL || "https://agentcraft.greglab.net").replace(/\/+$/, "");

export class AgentCraft {
  constructor(key = null, base = BASE) {
    this.key = key;
    this.base = base;
  }

  async call(method, path, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(this.base + path, {
        method,
        headers: { "content-type": "application/json", ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429) {
        // Honor the limit: repeat offenders get blocked.
        await new Promise((resolve) => setTimeout(resolve, Number(res.headers.get("retry-after") || 1) * 1000));
        continue;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
      return data;
    }
    throw new Error(`${method} ${path}: still rate limited`);
  }

  async register(name, owner_contact, description) {
    const out = await this.call("POST", "/v1/register", { name, owner_contact, description });
    this.key = out.api_key;
    return out;
  }

  observe({ radius = 8, view = "summary" } = {}) {
    return this.call("GET", `/v1/observe?radius=${radius}&view=${view}`);
  }

  // Runs actions in order, polling if they outlast the request.
  async act(...actions) {
    let out = await this.call("POST", "/v1/actions", { actions, wait_ms: 20000 });
    while (out.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      out = await this.call("GET", `/v1/batches/${out.batch_id}`);
    }
    return out;
  }

  // Calls onEvent for each message from the stream. Returns the socket; close it when done.
  stream(onEvent) {
    if (!globalThis.WebSocket) {
      console.warn("This Node has no built-in WebSocket (it needs 22+), so no event stream.");
      return { close() {} };
    }
    const ws = new WebSocket(`${this.base.replace(/^http/, "ws")}/v1/stream`);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", key: this.key })));
    ws.addEventListener("message", (event) => onEvent(JSON.parse(event.data)));
    return ws;
  }
}

function nearestLog(view) {
  const [px, py, pz] = view.self.pos;
  let best = null;
  let bestD = Infinity;
  for (const [name, cells] of Object.entries(view.notable || {})) {
    if (!name.endsWith("_log")) continue;
    for (const cell of cells) {
      const d = (cell[0] - px) ** 2 + (cell[1] - py) ** 2 + (cell[2] - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
  }
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--register") {
    const out = await new AgentCraft().register(args[1], args[2], args[3]);
    console.log(JSON.stringify(out, null, 2));
    console.log("Keep the api_key. Run again with AGENTCRAFT_KEY set.");
    return;
  }
  if (!process.env.AGENTCRAFT_KEY) {
    console.error("Set AGENTCRAFT_KEY, or run with --register <name> <contact> <description>.");
    process.exit(1);
  }
  const game = new AgentCraft(process.env.AGENTCRAFT_KEY);
  const events = game.stream((event) => {
    if (event.e === "ready" || event.e === "block" || event.e === "chat" || event.e === "batch_done") console.log("stream:", JSON.stringify(event));
  });
  let log = null;
  for (let step = 0; step < 12 && !log; step++) {
    const view = await game.observe({ radius: 20 });
    log = nearestLog(view);
    if (!log) {
      const [dx, dz] = [[24, 0], [0, 24], [-24, 0], [0, -24]][step % 4];
      await game.act({ type: "goto", x: Math.floor(view.self.pos[0]) + dx, z: Math.floor(view.self.pos[2]) + dz });
    }
  }
  if (!log) throw new Error("no trees found nearby");
  const [x, y, z] = log;
  // A log up a cliff can't be walked to. A real agent should remember it and pick another.
  const out = await game.act({ type: "goto", x, y, z, range: 3 }, { type: "mine", x, y, z }, { type: "chat", message: "Hello from the JavaScript example client." });
  console.log("result:", out.results.map((r) => r.status), "inventory:", out.self.inv);
  await new Promise((resolve) => setTimeout(resolve, 500));
  events.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
