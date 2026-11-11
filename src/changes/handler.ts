import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { publishChanges } from "./events.js";
const client = new SNSClient({});
export async function handler(event: unknown) {
  return publishChanges(event, async (change) => {
    await client.send(
      new PublishCommand({
        TopicArn: process.env.CHANGES_TOPIC_ARN!,
        Message: JSON.stringify(change),
        MessageAttributes: {
          project: { DataType: "String", StringValue: change.project },
          action: { DataType: "String", StringValue: change.action },
        },
      }),
    );
  });
}
