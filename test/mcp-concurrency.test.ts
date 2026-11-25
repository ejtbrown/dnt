import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  fixture,
  mint,
  origin,
  clientId,
  formRequest,
} from "./mcp-fixtures.js";

test("parallel public MCP reads retain access across ordinary sequential refresh boundaries", async (t) => {
  const f = fixture();
  const clients: Client[] = [];
  const connect = async (access: string) => {
    const client = new Client({ name: "concurrent-read-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${access}` } },
        fetch: async (input, init) => f.http(new Request(input, init)),
      }),
    );
    return client;
  };
  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError ?? false, false);
    return result.structuredContent as any;
  };
  const reads = async (client: Client) => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        call(client, index % 2 ? "get_project" : "list_work_items", {
          project: "PAR",
        }),
      ),
    );
    results.forEach((result, index) => {
      if (index % 2) assert.equal(result.result.name, "Parallel reads");
      else assert.deepEqual(result.result.items, []);
    });
    assert.ok((await call(client, "get_identity")).result.principal);
  };
  let tokens = await mint(f);
  let client = await connect(tokens.access_token);
  try {
    await call(client, "create_project", {
      input: { slug: "PAR", name: "Parallel reads" },
      agentName: "Concurrent Read Test",
      idempotencyKey: randomUUID(),
    });
    await reads(client);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    for (let boundary = 0; boundary < 2; boundary++) {
      clock += 901_000;
      // The expired access token is not sent again. Each current refresh token
      // is exchanged exactly once, as required of a coordinated OAuth caller.
      const renewed = await f.http(
        formRequest("/oauth/token", {
          client_id: clientId,
          resource: `${origin}/mcp`,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          scope: "dnt:read",
        }),
      );
      assert.equal(renewed.status, 200);
      tokens = await renewed.json();
      assert.equal(tokens.expires_in, 900);
      client = await connect(tokens.access_token);
      await reads(client);
      const denied = await client.callTool({
        name: "create_project",
        arguments: {
          input: { slug: "DENIED", name: "Must not be created" },
          agentName: "Concurrent Read Test",
          idempotencyKey: randomUUID(),
        },
      });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied._meta), /insufficient_scope/);
      assert.equal(
        (await call(client, "list_projects")).result.items.length,
        1,
      );
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});
