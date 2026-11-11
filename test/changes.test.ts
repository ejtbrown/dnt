import test from "node:test";
import assert from "node:assert/strict";
import { fromStreamRecord, publishChanges } from "../src/changes/events.js";
const record = (action = "item.updated", seq = "1") => ({
  eventName: "INSERT",
  dynamodb: {
    SequenceNumber: seq,
    NewImage: {
      pk: { S: "PROJECT#ROOT" },
      sk: { S: "AUDIT#2026#uuid" },
      value: {
        M: {
          action: { S: action },
          target: { S: "ROOT-1" },
          at: { S: "2026-11-11T00:00:00Z" },
          content: { S: "PRIVATE" },
          principal: { S: "PRIVATE" },
        },
      },
    },
  },
});
test("change events are metadata only and use stable audit identity", () => {
  const change = fromStreamRecord(record())!;
  assert.equal(change.project, "ROOT");
  assert.equal(change.id, "PROJECT#ROOT/AUDIT#2026#uuid");
  assert.equal(JSON.stringify(change).includes("PRIVATE"), false);
  assert.equal(fromStreamRecord(record("member.added")), undefined);
  assert.equal(
    fromStreamRecord({ ...record(), eventName: "MODIFY" }),
    undefined,
  );
  for (const action of [
    "doc.updated",
    "document.deleted",
    "comment.created",
    "reaction.created",
    "project.deleted",
    "membership.removed",
    "membership.set",
  ])
    assert.ok(fromStreamRecord(record(action)));
});
test("publisher reports failed records for bounded stream retry", async () => {
  let calls = 0;
  const result = await publishChanges(
    { Records: [record(), record("doc.updated", "2")] },
    async () => {
      if (++calls === 1) throw Error("unavailable");
    },
  );
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: "1" }] });
  assert.equal(calls, 2);
});
