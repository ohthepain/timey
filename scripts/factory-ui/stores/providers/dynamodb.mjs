import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStore, hash, storeError, verifyReceipt } from './records.mjs';
import { readProjectEnv } from '../../project-env.mjs';

function transactionChange(expected, writes, key, table) {
  const condition =
    expected.revision === null
      ? { ConditionExpression: 'attribute_not_exists(PK)' }
      : {
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': expected.revision },
        };
  const common = { TableName: table, ...condition };
  const itemKey = key('R#' + expected.key);
  if (!writes.has(expected.key)) return { ConditionCheck: { ...common, Key: itemKey } };
  const value = writes.get(expected.key);
  return value ? { Put: { ...common, Item: { ...itemKey, ...value } } } : { Delete: { ...common, Key: itemKey } };
}

export async function openDynamoRecords(config, { projectId, root }) {
  assertStore(typeof config.table === 'string' && /^[\w.-]{3,255}$/.test(config.table), 'Configure a DynamoDB table.');
  const env = { ...readProjectEnv(root), ...process.env };
  const client = new DynamoDBClient({
    region: config.region || env[config.regionEnv || 'AWS_REGION'],
    ...(config.endpoint && { endpoint: config.endpoint }),
  });
  const document = DynamoDBDocumentClient.from(client);
  const partition = `P#${hash(projectId)}#S#${hash(config.id)}`;
  const key = (sk) => ({ PK: partition, SK: sk });
  const recordKey = (value) => 'R#' + value;
  const operationKey = (value) => 'O#' + hash(value);
  const getItem = async (sk) =>
    (await document.send(new GetCommand({ TableName: config.table, Key: key(sk), ConsistentRead: true }))).Item;
  const row = (item) => (item ? { key: item.key, revision: item.revision, value: item.value } : null);
  function unavailable() {
    return storeError('STORE_UNAVAILABLE', 'The configured DynamoDB store is unavailable.');
  }
  const receiptFor = async (request) => {
    const prior = await getItem(operationKey(request.operationId));
    return prior ? verifyReceipt(prior.receipt, request.inputDigest) : null;
  };
  async function recoverTransaction(request, error, attempt) {
    const landed = await receiptFor(request);
    if (landed) return landed;
    const reasons = error.CancellationReasons || [];
    if (reasons.some((reason) => reason.Code === 'ConditionalCheckFailed'))
      throw storeError('STORE_CONFLICT', 'The stored revision changed. Refresh before editing.');
    if (!['TransactionCanceledException', 'TransactionConflictException'].includes(error.name)) throw error;
    if (attempt === 4) throw unavailable();
    await delay(20 * (attempt + 1));
    return null;
  }
  return {
    async get(value) {
      try {
        return row(await getItem(recordKey(value)));
      } catch {
        throw unavailable();
      }
    },
    async list(prefix) {
      try {
        const result = [];
        let cursor;
        do {
          const page = await document.send(
            new QueryCommand({
              TableName: config.table,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
              ExpressionAttributeValues: { ':pk': partition, ':prefix': recordKey(prefix) },
              ConsistentRead: true,
              ...(cursor && { ExclusiveStartKey: cursor }),
            })
          );
          result.push(...(page.Items || []).map(row));
          cursor = page.LastEvaluatedKey;
        } while (cursor);
        return result;
      } catch {
        throw unavailable();
      }
    },
    async commit(request) {
      const writeMap = new Map(request.writes.map((write) => [write.key, write.record]));
      const TransactItems = request.expected.map((expected) =>
        transactionChange(expected, writeMap, key, config.table)
      );
      TransactItems.push({
        Put: {
          TableName: config.table,
          Item: { ...key(operationKey(request.operationId)), receipt: request.receipt },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
      try {
        const prior = await receiptFor(request);
        if (prior) return prior;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await document.send(new TransactWriteCommand({ TransactItems }));
            return request.receipt;
          } catch (error) {
            const landed = await recoverTransaction(request, error, attempt);
            if (landed) return landed;
          }
        }
      } catch (error) {
        if (error.code?.startsWith('STORE_')) throw error;
        throw unavailable();
      }
    },
    close() {
      client.destroy();
    },
  };
}
