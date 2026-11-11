import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  Conflict,
  type Store,
  type Row,
  type Write,
  type Check,
  type Blobs,
} from "./store.js";

export class DynamoStore implements Store {
  constructor(
    readonly table: string,
    readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ) {}
  async get<T>(pk: string, sk: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return result.Item as Row<T> | undefined;
  }
  async query<T>(pk: string, prefix: string, limit: number, after?: string) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ConsistentRead: true,
        Limit: limit,
        ExclusiveStartKey: after ? { pk, sk: after } : undefined,
      }),
    );
    return {
      rows: (result.Items ?? []) as Row<T>[],
      next: result.LastEvaluatedKey?.sk as string | undefined,
    };
  }
  async range<T>(
    pk: string,
    lower: string,
    upper: string,
    limit: number,
    after?: string,
  ) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :lower AND :upper",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":lower": lower,
          ":upper": upper,
        },
        ConsistentRead: true,
        Limit: limit,
        ExclusiveStartKey: after ? { pk, sk: after } : undefined,
      }),
    );
    return {
      rows: (result.Items ?? []) as Row<T>[],
      next: result.LastEvaluatedKey?.sk as string | undefined,
    };
  }
  async commit(writes: Write[], checks: Check[] = []) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            ...writes.map((w) => {
              const condition = {
                TableName: this.table,
                ConditionExpression:
                  w.expected === null ? "attribute_not_exists(pk)" : "#v = :v",
                ...(w.expected !== null
                  ? {
                      ExpressionAttributeNames: { "#v": "version" },
                      ExpressionAttributeValues: { ":v": w.expected },
                    }
                  : {}),
              };
              return w.remove
                ? {
                    Delete: {
                      ...condition,
                      Key: { pk: w.row.pk, sk: w.row.sk },
                    },
                  }
                : { Put: { ...condition, Item: w.row } };
            }),
            ...checks.map((c) => ({
              ConditionCheck: {
                TableName: this.table,
                Key: { pk: c.pk, sk: c.sk },
                ConditionExpression: "#v = :v",
                ExpressionAttributeNames: { "#v": "version" },
                ExpressionAttributeValues: { ":v": c.version },
              },
            })),
          ],
        }),
      );
    } catch (error: any) {
      if (
        error.name === "TransactionCanceledException" &&
        error.CancellationReasons?.some((r: any) =>
          ["ConditionalCheckFailed", "TransactionConflict"].includes(r.Code),
        )
      )
        throw new Conflict();
      throw error;
    }
  }
}
export class S3Blobs implements Blobs {
  constructor(
    readonly bucket: string,
    readonly client = new S3Client({}),
  ) {}
  async put(key: string, content: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: "text/markdown; charset=utf-8",
        IfNoneMatch: "*",
      }),
    );
  }
  async get(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("Missing document content");
    return result.Body.transformToString();
  }
}
