import { DynamoStore } from "../api/aws-store.js";
import { CognitoDirectory } from "./cognito.js";
import { synchronize } from "./sync.js";
import { slugSchema } from "../shared/model.js";
const db = new DynamoStore(process.env.TABLE_NAME!);
const directory = new CognitoDirectory(process.env.COGNITO_POOL_ID!);
export async function handler(event: any) {
  for (const record of event.Records ?? []) {
    const key = record.dynamodb?.Keys;
    if (key?.sk?.S !== "GROUP_SYNC" || !key.pk?.S?.startsWith("PROJECT#")) continue;
    const slug = slugSchema.parse(key.pk.S.replace(/^PROJECT#/, ""));
    await synchronize(db, directory, process.env.PUBLIC_ORIGIN!, slug);
  }
}
