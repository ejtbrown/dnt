import { synchronize } from "../src/groups/sync.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  fixture,
  mint,
  admin,
  member,
  origin,
  type Fixture,
} from "./mcp-fixtures.js";
import { operations } from "../src/mcp/tools.js";
async function connect(f: Fixture, access?: string) {
  const client = new Client({ name: "dnt-tests", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/mcp`),
    {
      requestInit: access
        ? { headers: { authorization: `Bearer ${access}` } }
        : {},
      fetch: async (input, init) => f.http(new Request(input, init)),
    },
  );
  await client.connect(transport);
  return client;
}
const rpc = (
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) =>
  new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

test("official MCP client initializes stateless HTTP, discovers complete typed tools, and receives OAuth challenges", async () => {
  const f = fixture(),
    client = await connect(f);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, operations.length + 2);
    const openapi = JSON.parse(readFileSync("public/openapi.json", "utf8"));
    const expected = Object.values(openapi.paths)
      .flatMap((methods: any) =>
        Object.values(methods).map((o: any) => o.operationId),
      )
      .sort();
    assert.deepEqual(operations.map((o) => o.operationId).sort(), expected);
    assert.deepEqual(
      tools
        .map((t) => t._meta?.["dnt/operationId"])
        .filter(Boolean)
        .sort(),
      expected,
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
      assert.equal(tool.annotations?.openWorldHint, false);
      assert.ok(tool._meta?.securitySchemes);
    }
    assert.equal(
      tools.find((t) => t.name === "get_document")?.annotations?.readOnlyHint,
      true,
    );
    assert.equal(
      tools.find((t) => t.name === "remove_member")?.annotations
        ?.destructiveHint,
      true,
    );
    const denied = await client.callTool({
      name: "get_identity",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.ok(denied._meta?.["mcp/www_authenticate"]);
  } finally {
    await client.close();
  }
});

test("the complete catalog has regex patterns consumable by Python MCP clients", async () => {
  const f = fixture(),
    client = await connect(f, (await mint(f)).access_token);
  try {
    const catalog = await client.listTools();
    // Python's standard regex compiler catches JS-only escapes that pass the
    // TypeScript SDK's own schema validation but break downstream importers.
    execFileSync(
      "python3",
      [
        "-c",
        `
import json, re, sys
def check(value, path):
    if isinstance(value, dict):
        if "pattern" in value:
            try:
                re.compile(value["pattern"])
            except re.error as error:
                raise ValueError(path + ": " + str(error)) from None
        for key, child in value.items():
            check(child, path + "/" + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            check(child, path + "/" + str(index))
for tool in json.load(sys.stdin)["tools"]:
    check(tool["inputSchema"], tool["name"] + "/input")
    check(tool.get("outputSchema", {}), tool["name"] + "/output")
`,
      ],
      { input: JSON.stringify(catalog), stdio: ["pipe", "pipe", "pipe"] },
    );
  } finally {
    await client.close();
  }
});

test("MCP exposes the full project, hierarchy, workflow, assignment, docs/history/restore, membership and audit lifecycle", async () => {
  const f = fixture(),
    tokens = await mint(f),
    client = await connect(f, tokens.access_token);
  const invoked = new Set<string>();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    invoked.add(name);
    const response = await client.callTool({
      name,
      arguments: {
        ...(operations.find((o) => o.name === name)?.method !== "GET"
          ? { agentName: "Lifecycle Agent" }
          : {}),
        ...args,
      },
    });
    assert.ok(!response.isError, JSON.stringify(response));
    return (response.structuredContent as any).result;
  };
  try {
    assert.equal((await call("get_identity")).canCreateProject, true);
    const profile = await client.callTool({
      name: "get_profile",
      arguments: {},
    });
    assert.equal((profile.structuredContent as any)?.id, admin.slice(8));
    await call("create_project", {
      input: { slug: "ROOT", name: "Root" },
      idempotencyKey: randomUUID(),
    });
    await call("create_project", {
      input: { slug: "AB", name: "Other" },
      idempotencyKey: randomUUID(),
    });
    const projects = await call("list_projects", { limit: 1 });
    assert.ok(projects.nextCursor);
    assert.equal(
      (await call("list_projects", { cursor: projects.nextCursor, limit: 1 }))
        .items.length,
      1,
    );
    assert.equal((await call("get_project", { project: "ROOT" })).name, "Root");
    const initiative = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Initiative", title: "Launch" },
      idempotencyKey: randomUUID(),
    });
    const epic = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Epic", title: "API", parentId: initiative.id },
      idempotencyKey: randomUUID(),
    });
    const create = {
      project: "ROOT",
      input: {
        kind: "Task",
        title: "Implement",
        parentId: epic.id,
        assignee: admin,
      },
      idempotencyKey: randomUUID(),
    };
    const task = await call("create_work_item", create);
    const comment = await call("create_work_item_comment", {
      project: "ROOT",
      id: task.id,
      input: { content: "Implementation update" },
      idempotencyKey: randomUUID(),
      agentName: "Planning Agent",
    });
    assert.equal(
      (await call("list_work_item_comments", { project: "ROOT", id: task.id }))
        .items.length,
      1,
    );
    const commentArgs = { project: "ROOT", id: task.id, commentId: comment.id };
    await call("update_work_item_comment", {
      ...commentArgs,
      input: { content: "**Edited**" },
      expectedVersion: 1,
      agentName: "Editor",
    });
    const commentHistory = await call(
      "list_work_item_comment_revisions",
      commentArgs,
    );
    assert.equal(commentHistory.items.length, 2);
    assert.equal(commentHistory.items[1].editAttribution.agentName, "Editor");
    assert.equal(task.id, "ROOT-3");
    assert.equal(task.state, "Concept");
    assert.deepEqual(await call("create_work_item", create), task);
    assert.equal(
      (await call("get_work_item", { project: "ROOT", id: task.id })).assignee,
      admin,
    );
    let current = task;
    for (const state of [
      "Implement",
      "Needs Attention",
      "Review",
      "Done",
      "Cancelled",
      "Concept",
    ])
      current = await call("update_work_item", {
        project: "ROOT",
        id: task.id,
        patch: { state, assignee: null },
        expectedVersion: current.version,
      });
    assert.equal(current.assignee, null);
    const secondEpic = await call("create_work_item", {
      project: "ROOT",
      input: { kind: "Epic", title: "UI", parentId: initiative.id },
      idempotencyKey: randomUUID(),
    });
    current = await call("update_work_item", {
      project: "ROOT",
      id: task.id,
      patch: {
        parentId: secondEpic.id,
        title: "Moved",
        description: "Details",
      },
      expectedVersion: current.version,
    });
    assert.equal(current.parentId, secondEpic.id);
    assert.equal(
      (
        await client.callTool({
          name: "update_work_item",
          arguments: {
            project: "ROOT",
            id: task.id,
            patch: { state: "Done" },
            expectedVersion: 1,
          },
        })
      ).isError,
      true,
    );
    const work = await call("list_work_items", { project: "ROOT", limit: 1 });
    assert.ok(work.nextCursor);
    assert.equal(
      (
        await call("list_work_items", {
          project: "ROOT",
          cursor: work.nextCursor,
        })
      ).items.length,
      3,
    );
    for (const tree of ["User", "Maintainer", "Administrator"]) {
      const page = await call("create_document", {
        project: "ROOT",
        tree,
        input: { title: "Guide", content: "# First" },
        idempotencyKey: randomUUID(),
      });
      const args = { project: "ROOT", tree, documentId: page.id };
      const child = await call("create_document", {
        project: "ROOT",
        tree,
        input: { title: "Child", content: "Nested", parentId: page.id },
        idempotencyKey: randomUUID(),
      });
      const listed = await call("list_documents", { project: "ROOT", tree });
      assert.equal(
        listed.items.find((p: any) => p.title === "Child").parentId,
        page.id,
      );
      assert.equal((await call("get_document", args)).content, "# First");
      await call("update_document", {
        ...args,
        patch: { title: "New title", content: "# Second" },
        expectedVersion: 1,
      });
      assert.equal(
        (await call("list_document_revisions", { ...args, limit: 1 })).items
          .length,
        1,
      );
      assert.equal(
        (await call("get_document_revision", { ...args, revision: 1 })).content,
        "# First",
      );
      const diff = await call("compare_document_revisions", {
        ...args,
        fromRevision: 1,
        toRevision: 2,
      });
      assert.equal(
        diff.content.parts.find((p: any) => p.type === "added").text,
        "# Second",
      );
      await call("restore_document_revision", {
        ...args,
        revision: 1,
        expectedVersion: 2,
      });
      const restored = await call("get_document", args);
      assert.equal(restored.content, "# First");
      assert.equal(restored.title, "Guide");
      assert.equal(restored.version, 3);
      const reference = new URL(restored.url).pathname.slice(3);
      assert.equal(
        (await call("resolve_document_link", { reference })).id,
        page.id,
      );
      await call("update_document", {
        ...args,
        patch: { public: true },
        expectedVersion: 3,
        agentName: "Publisher",
      });
      assert.equal(
        (await call("get_public_document", { reference })).content,
        "# First",
      );
      await call("delete_document", {
        ...args,
        documentId: child.id,
        expectedVersion: 1,
        agentName: "Cleaner",
      });
      await call("delete_document", {
        ...args,
        expectedVersion: 4,
        agentName: "Cleaner",
      });
      assert.ok(
        (
          await client.callTool({
            name: "get_public_document",
            arguments: { reference },
          })
        ).isError,
      );
      assert.ok(
        (await call("list_audit_events", { project: "ROOT" })).items.some(
          (a: any) =>
            a.action === "document.deleted" &&
            a.attribution.agentName === "Cleaner",
        ),
      );
    }
    await call("set_member", {
      project: "ROOT",
      input: { principal: member, role: "User" },
      idempotencyKey: randomUUID(),
    });
    f.settings.identity = {
      principal: member,
      username: "member",
      scopes: [],
      profile: { id: member.slice(8) },
    };
    const user = await connect(f, (await mint(f)).access_token);
    try {
      assert.ok(
        !(
          await user.callTool({
            name: "get_work_item",
            arguments: { project: "ROOT", id: task.id },
          })
        ).isError,
      );
      for (const tree of ["User", "Maintainer", "Administrator"])
        assert.ok(
          !(
            await user.callTool({
              name: "list_documents",
              arguments: { project: "ROOT", tree },
            })
          ).isError,
        );
      for (const [name, args] of [
        ["list_members", { project: "ROOT" }],
        ["list_audit_events", { project: "ROOT" }],
        [
          "create_project",
          {
            input: { slug: "NO", name: "Denied" },
            idempotencyKey: randomUUID(),
          },
        ],
      ] as const)
        assert.equal(
          (await user.callTool({ name, arguments: args })).isError,
          true,
        );
      assert.equal(
        (await call("list_members", { project: "ROOT" })).items.length,
        2,
      );
      await call("set_member", {
        project: "ROOT",
        input: { principal: member, role: "Maintainer" },
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
      });
      assert.ok(
        !(
          await user.callTool({
            name: "list_documents",
            arguments: { project: "ROOT", tree: "Maintainer" },
          })
        ).isError,
      );
      await call("remove_member", {
        project: "ROOT",
        principal: member,
        expectedVersion: 2,
      });
      assert.equal(
        (
          await user.callTool({
            name: "get_project",
            arguments: { project: "ROOT" },
          })
        ).isError,
        true,
        "membership revocation applies immediately to existing MCP tokens",
      );
    } finally {
      await user.close();
    }
    assert.ok(
      (await call("list_audit_events", { project: "ROOT" })).items.length > 10,
    );
    assert.equal(
      (
        await client.callTool({
          name: "remove_member",
          arguments: { project: "ROOT", principal: admin, expectedVersion: 1 },
        })
      ).isError,
      true,
    );
    await call("list_project_users", {
      project: "ROOT",
      search: "local",
      limit: 1,
    });
    await call("reconcile_project_groups", {
      project: "ROOT",
      idempotencyKey: randomUUID(),
      agentName: "Group Agent",
    });
    await synchronize(f.serviceDb, f.directory, origin, "ROOT");
    assert.equal(
      (await call("get_project_groups", { project: "ROOT" })).sync.status,
      "ready",
    );
    assert.equal(
      (
        await call("list_project_group_users", {
          project: "ROOT",
          role: "Administrator",
        })
      ).items.length,
      1,
    );
    const scope = { project: "ROOT", id: task.id };
    const revisions = await call("list_work_item_revisions", scope);
    assert.ok(revisions.items.length > 1);
    assert.equal(
      (await call("get_work_item_revision", { ...scope, revision: 1 })).title,
      "Implement",
    );
    const approval = await call("react_to_comment", {
      ...commentArgs,
      input: { kind: "approval", commentVersion: 2 },
      idempotencyKey: randomUUID(),
    });
    assert.equal(
      (await call("list_comment_reactions", commentArgs)).items[0].kind,
      "approval",
    );
    await call("withdraw_comment_reaction", {
      ...commentArgs,
      reactionId: approval.id,
      expectedVersion: 1,
    });
    const imported = await call("import_work_item_comment", {
      ...scope,
      input: {
        content: "Original approval",
        source: {
          system: "jira",
          id: "107",
          url: "https://example.atlassian.net/browse/ROOT-1",
          author: "Original author",
        },
        historicalApprovals: [{ kind: "approval", author: "Erick" }],
      },
      idempotencyKey: randomUUID(),
    });
    assert.equal(imported.importedEvidence.historical, true);
    await call("delete_work_item", {
      ...scope,
      expectedVersion: current.version,
    });
    const beforeDelete = await call("get_project", { project: "ROOT" });
    await call("delete_project", {
      project: "ROOT",
      expectedVersion: beforeDelete.version,
      agentName: "Group Agent",
    });
    await synchronize(f.serviceDb, f.directory, origin, "ROOT");
    assert.equal(
      (await call("get_project_groups", { project: "ROOT" })).sync.status,
      "deleted",
    );
    assert.deepEqual(
      [...invoked].sort(),
      [...operations.map((o) => o.name), "restore_document_revision"].sort(),
    );
  } finally {
    await client.close();
  }
});

test("read-only OAuth scopes cannot mutate; caller identity cannot be overridden by tool arguments", async () => {
  const f = fixture(),
    client = await connect(f, (await mint(f, "dnt:read")).access_token);
  try {
    const denied = await client.callTool({
      name: "create_project",
      arguments: {
        input: { slug: "ROOT", name: "No" },
        agentName: "Read-only Test",
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied._meta), /insufficient_scope/);
    assert.equal(
      (
        await client.callTool({
          name: "get_identity",
          arguments: { principal: member },
        })
      ).isError,
      true,
    );
    assert.equal(f.serviceDb.rows.size, 0);
  } finally {
    await client.close();
  }
});

test("HTTP validates Origin, bearer tokens, protocol versions and content negotiation without caching", async () => {
  const f = fixture();
  const response = await f.http(new Request(`${origin}/mcp`));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate")!, /resource_metadata/);
  for (const origin of ["https://evil.example", "null"])
    assert.equal((await f.http(rpc("tools/list", {}, { origin }))).status, 403);
  assert.equal(
    (await f.http(rpc("tools/list", {}, { authorization: "Bearer invalid" })))
      .status,
    401,
  );
  assert.equal(
    (
      await f.http(
        rpc("tools/list", {}, { "mcp-protocol-version": "2099-01-01" }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.http(rpc("tools/list", {}, { accept: "text/html" }))).status,
    406,
  );
  const token = (await mint(f)).access_token;
  const get = await f.http(
    new Request(`${origin}/mcp`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
      },
    }),
  );
  assert.equal(get.status, 405);
  const init = await f.http(
    rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("cache-control"), "no-store");
  assert.equal(init.headers.get("mcp-session-id"), null);
  const notification = await f.http(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    }),
  );
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("an existing MCP session loses project creation and deletion when dnt-admin membership is removed", async () => {
  const f = fixture(),
    client = await connect(f, (await mint(f)).access_token);
  try {
    const input = {
      input: { slug: "ROOT", name: "Root" },
      idempotencyKey: randomUUID(),
      agentName: "Admin Agent",
    };
    assert.ok(
      !(await client.callTool({ name: "create_project", arguments: input }))
        .isError,
    );
    f.directory.administrators.delete(admin);
    const identity = await client.callTool({
      name: "get_identity",
      arguments: {},
    });
    assert.equal((identity.structuredContent as any).result.isDntAdmin, false);
    assert.equal(
      (await client.callTool({ name: "create_project", arguments: input }))
        .isError,
      true,
    );
    const denied = await client.callTool({
      name: "delete_project",
      arguments: {
        project: "ROOT",
        expectedVersion: 1,
        agentName: "Admin Agent",
      },
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /dnt-admin/);
    f.directory.administrators.add(admin);
    assert.ok(
      !(
        await client.callTool({
          name: "delete_project",
          arguments: {
            project: "ROOT",
            expectedVersion: 1,
            agentName: "Admin Agent",
          },
        })
      ).isError,
    );
  } finally {
    await client.close();
  }
});
