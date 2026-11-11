/** Metadata-only notifications. Consumers fetch content through the authenticated API. */
export interface ChangeEvent {
  schemaVersion: 1;
  id: string;
  project: string;
  action: string;
  target: string;
  at: string;
}

export function fromStreamRecord(record: any): ChangeEvent | undefined {
  if (record.eventName !== "INSERT") return;
  const image = record.dynamodb?.NewImage;
  const pk = image?.pk?.S;
  const sk = image?.sk?.S;
  if (!pk?.startsWith("PROJECT#") || !sk?.startsWith("AUDIT#")) return;
  const value = image?.value?.M;
  const action = value?.action?.S;
  if (
    !/^(item|comment|document|doc|reaction)\./.test(action ?? "") &&
    ![
      "project.deleted",
            "membership.removed",
      "membership.set",
    ].includes(action ?? "")
  )
    return;
  const target = value?.target?.S;
  const at = value?.at?.S;
  if (typeof target !== "string" || typeof at !== "string") return;
  return {
    schemaVersion: 1,
    id: `${pk}/${sk}`,
    project: pk.slice(8),
    action,
    target,
    at,
  };
}

/** At-least-once delivery: use the durable audit key as the deduplication ID. */
export async function publishChanges(
  event: any,
  publish: (change: ChangeEvent) => Promise<void>,
) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    const change = fromStreamRecord(record);
    if (!change) continue;
    try {
      await publish(change);
    } catch {
      batchItemFailures.push({
        itemIdentifier: record.dynamodb.SequenceNumber,
      });
    }
  }
  return { batchItemFailures };
}
