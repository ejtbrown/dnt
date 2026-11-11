# Deploy and operate dnt

## Current prerequisites

The checked-in configuration targets account `264702148921`, region `us-east-2`, and `dnt.ejtbrown.com`. The shared Cognito pool and login domain are owned by the sibling `ejtbrown-cognito` project.

For a new installation:

1. Configure an invitation-only Cognito pool and HTTPS login domain. Register the public clients described by `config/cognito-application.json` and `config/cognito-mcp-application.json`, adjusting their redirects to your domain. The second client is dedicated to MCP account linking.
2. Set all values in `config/deploy.json`: account, region, hosted zone, domain, repository, immutable GitHub repository/owner IDs, trusted runner actor IDs, CodeConnections ARN, pool/client IDs, `mcpCognitoClientId`, trusted `mcpClientMetadataUrls`, and auth domain. Pool/client IDs are public identifiers; client secrets must never enter this browser application.
3. Declare `dnt-admin` in the shared identity service group manifest, then add the initial operator to that Cognito group. dnt verifies current membership when creating or deleting projects; there is no deployment allowlist. Creation gives that account project Administrator rights, and deletion requires both permissions.
4. Grant your CodeConnections GitHub App access to the repository and configure GitHub's AWS OIDC provider. Limit the App's repository selection because connection-token access is scoped to the connection.
5. Register agent IAM role ARNs in `agentRoles` before granting project membership. The application does not create IAM identities.

## Initial tooling setup

With Node.js 24 and administrator credentials for the target account:

```sh
npm ci
npm run check
AWS_PROFILE=default npm run bootstrap
```

`bootstrap` verifies the account, displays the tooling diff, deploys `dnt-tooling`, then creates dedicated `dnt-cdk-toolkit` bootstrap stacks with qualifier `dntkit001` in `us-east-2` and `us-east-1`. It attaches the dnt CloudFormation execution policy instead of the default AdministratorAccess policy. It does not modify another project's CDK toolkit.

The CodeBuild project is a GitHub Actions runner using the existing CodeConnections GitHub connection. Its ambient role can retrieve that connection's runner/source token and write its logs. It cannot deploy. [AWS CodeBuild runner workflow](https://docs.aws.amazon.com/codebuild/latest/userguide/action-runner.html).

The separate GitHub OIDC deployment role trusts only `repo:ejtbrown@9349498/dnt@1451000902:ref:refs/heads/main`, with the STS audience. The tooling stack is not included in routine application deployment. Treat future tooling/policy changes as an administrator operation using the bootstrap command after review.

## Application release

Publish an initial baseline to GitHub, install the PR-only main ruleset with `npm run protect-main`, and release the implementation through a pull request. The ruleset requires a successful `validate` check and blocks force pushes and branch deletion. It requires no additional reviewer for a single-owner repository.

- Pull requests from this repository run `npm run check` and the browser workflow tests on CodeBuild, without deployment permissions. Fork PRs are skipped. CodeBuild additionally requires the triggering GitHub actor to be in `runnerActorIds` (initially only the owner), so changing a fork’s workflow cannot bypass the runner’s server-side gate. Review external contributions before copying them to a trusted branch; add collaborator IDs deliberately.
- A merged pull request to `main` runs the same checks, assumes the dnt deployment role through GitHub OIDC, and runs `npm run deploy`.
- Deployment jobs are serialized and are not cancelled halfway through infrastructure changes.
- `deploy` verifies the account and both Cognito clients, synthesizes stacks, displays diffs, deploys certificate/data, then deploys the application using the certificate output and Cognito parameters.
- Before assuming AWS credentials, the workflow verifies that its commit is the merge result of a pull request to this repository’s `main`. Direct pushes and manual executions do not qualify.

The routine stacks are:

| Stack             | Region      | Owns                                                  |
| ----------------- | ----------- | ----------------------------------------------------- |
| `dnt-certificate` | `us-east-1` | ACM certificate and validation                        |
| `dnt-data`        | `us-east-2` | Product and OAuth DynamoDB tables, content bucket     |
| `dnt-app`         | `us-east-2` | API, Lambda, web bucket, CloudFront, DNS, logs, alarm |

The synth output contains the reviewable CloudFormation templates in ignored `cdk.out/`. Strong cross-stack references deliberately protect the data stack's exported resources. Do not rename stateful constructs or remove references without a migration plan.

## First project and sign-in

For MCP installation, OAuth lifetimes, complete tool coverage, and verification, see [the MCP guide](mcp.md).

After deployment, obtain `AgentApi`, `AgentInvokeArn`, `McpUrl`, and `Url` from `dnt-app` outputs. Open the site and sign in using the invited account. Complete the temporary-password change and Cognito MFA enrollment, then create the first project in the workspace.

Additional people must first be invited through the shared Cognito process. The app does not send invitations or create users. Have each person sign in and copy their `cognito:<sub>` identity from the workspace, or obtain their subject from the shared pool's user record. A project Administrator grants that identity membership. Never use email addresses as membership keys.

For an agent role, attach an IAM policy with `execute-api:Invoke` limited to the actual `AgentInvokeArn`. Add the canonical role ARN to the deployment's `agentRoles`, deploy, then grant `iam:arn:aws:iam::ACCOUNT:role/PATH/ROLE` the appropriate project role. Do not grant application-data bucket access to agents; all operations use the API.

## Live smoke checks

Run `AWS_PROFILE=default npm run smoke:storage` after the data stack exists to test the real DynamoDB/S3 adapters and service behavior. It isolates all records and objects under a random namespace and cleans only its own exact keys, including S3 versions. It does not test API Gateway authentication.

Perform these additional checks after initial deployment and relevant infrastructure or authentication changes:

1. Sign in through Cognito with an invited user, including the shared MFA/passkey flow. Confirm the exact callback and logout behavior. Reloading starts a new code flow because tokens stay in memory.
2. Confirm missing tokens, ID tokens, wrong app-client tokens, and unknown project identities cannot read content.
3. Create an initiative, epic, and task. Retry a POST with the same key and verify the original ID returns. Send two edits with the same `If-Match` and verify one fails.
4. Confirm a User can read every documentation tree and old revisions but cannot create/edit/delete content. Confirm a Maintainer can edit every tree and cannot manage membership. Confirm users can withdraw only their own prior reactions.
5. Exercise an IAM role's `/me`, project listing, and a permitted task edit. Verify the stable role identity matches its membership.
6. Verify private S3 URLs fail, `/api/*` responses are uncached, callback routing loads the SPA, and API failures remain JSON.
7. Check Lambda/API Gateway logs and CloudFront request metrics, provision operational alarm notifications, and test a restore into separate resources before relying on backups.

The tests cover service-level concurrency, authorization, revisions, pagination, and important synthesized resource settings. They do not prove AWS service policy execution or DynamoDB/S3 failure behavior end to end.

## Recovery and retention

DynamoDB point-in-time recovery restores to a new table. Restore S3 content alongside it and verify all committed revision pointers. Switch the application to restored resources through an explicit CDK migration; a new table name alone does not reconnect the stack automatically. If a table is restored to an earlier point, stop writes and account for identifiers already issued afterward before resuming; reusing old ordinals is unsafe.

S3 versioning and immutable content keys retain prior document bodies. Failed writes may leave orphan objects. Do not add blanket object-expiration rules; historical revisions can still reference old objects. In-app restoration writes a new revision using old content, preserving history.

Application rollback should deploy the prior compatible commit and its assets; it does not reverse data writes. Avoid incompatible schema changes without an explicit migration and rollback plan. Stateful resources remain retained on deletion, and stack/table deletion protection is enabled. Disabling those controls is not a routine cleanup step.

## Project group worker rollout and verification

Changes to the runtime boundary or CloudFormation execution policy require the operator to run `npm run bootstrap` with administrator credentials before merging an application release. This release adds shared-pool directory/group permissions, stream consumption, an SQS failure destination, and event-source mapping deployment permissions. The groups do not attach IAM roles, so the worker needs no `iam:PassRole`. The action baseline was checked with IAM Policy Autopilot against `src/groups/cognito.ts`, narrowed to the configured pool, and separated into HTTP read-only and worker write privileges.

After deployment, `npm run smoke:groups` exercises real DynamoDB transactions, the deployed stream worker, and Cognito group creation, administrator assignment, IAM denial, and deletion in a randomly named temporary project. It uses an existing enabled dnt-admin account in the in-process service, verifies creator group membership and denial for a synthetic IAM project administrator, and never creates/invites users. It does not bypass API authentication over HTTP. The script removes only records it created after confirming group deletion. If cleanup fails, it prints the temporary project slug for recovery and retains the outbox/records. Run `npm run smoke:mcp` separately to verify the deployed HTTP MCP catalog and authorization, and `npm run smoke:storage` for document storage.

For a persistent sync error, check Members → Cognito groups and the GroupWorker logs. Resolve any group ownership collision without taking over another application's group, then choose Retry synchronization. `GroupFailuresQueue` in the application stack outputs identifies exhausted events; its payload references stream failures and may require inspecting the original project row. A long-running `syncing` state after a timeout can also be retried. Existing projects need one explicit reconciliation after upgrading from a release without group synchronization. At this rollout the production data table contained no existing projects.

### dnt-admin rollout

The shared Cognito repository owns the `dnt-admin` declaration in `config/auth.json`. Deploy that manifest and add the existing operator to the group before releasing dnt enforcement. Update dnt's operator-owned runtime boundary with `npm run bootstrap` to allow `AdminListGroupsForUser` on the configured pool; HTTP Lambdas receive this read permission and the project worker does not need it. The SDK action is verified with IAM Policy Autopilot. `projectCreators` and `PROJECT_CREATORS` are removed, including their authorization fallback.

Group membership is checked through Cognito on each privileged request, including idempotent creation retries. Membership changes apply to an existing authenticated session without waiting for token refresh. A failed directory lookup denies the operation with 503. IAM identities and disabled/deleted accounts cannot satisfy this requirement. A request already authorized and in flight may finish during a concurrent group removal. Group membership itself is administered by identity operators, never by a project membership endpoint.

## Workflow and event release

This release adds immutable work-item revisions, explicit nested decision reactions and the [metadata-only change feed](change-events.md). Review and apply the scoped tooling-policy change before merging the application release: the runtime boundary adds `sns:Publish` only on `dnt-app-changes`, and the deployment policy adds topic resource management only for that exact topic. No subscriptions are created automatically. Run the full check and browser suite on the exact release commit, then verify the stream worker and an explicitly authorized receiver before retiring polling.

All project members now read all documentation trees. The trees are content audiences, not security partitions. User is strictly read-only, Maintainer can add/edit/soft-delete work items and add/edit/delete documents and comments, and Administrator additionally manages project membership. A project membership grant invites an existing enabled shared-Cognito account; DNT does not create new accounts or send enrollment email. Original author/actor labels remain historical; transport provenance (`web`, `agent`, `mcp`) is server-assigned, but a `web` API token is not proof of an interactive human action.
