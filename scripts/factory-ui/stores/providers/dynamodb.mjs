import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStore, hash, storeError, verifyReceipt, retireReceipt } from './records.mjs';
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
  async function query(prefix) {
    const result = [];
    let cursor;
    do {
      const page = await document.send(
        new QueryCommand({
          TableName: config.table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': partition, ':prefix': prefix },
          ConsistentRead: true,
          ...(cursor && { ExclusiveStartKey: cursor }),
        })
      );
      result.push(...(page.Items || []));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return result;
  }
  const retainedOperationKey = (id) => {
    assertStore(/^[a-f0-9]{64}$/.test(id), 'Choose a retained DynamoDB operation identity.');
    return 'O#' + id;
  };
  async function writeOperation(request, changesFor) {
    try {
      const prior = await receiptFor(request);
      if (prior) return prior;
      const TransactItems = await changesFor();
      TransactItems.push({
        Put: {
          TableName: config.table,
          Item: { ...key(operationKey(request.operationId)), receipt: request.receipt },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      });
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
  }
  return {
    async receipt(operationId) {
      try {
        return (await getItem(operationKey(operationId)))?.receipt ?? null;
      } catch {
        throw unavailable();
      }
    },
    async retainedPayloads() {
      try {
        const [records, operations] = await Promise.all([query('R#'), query('O#')]);
        return {
          records: records.map(row),
          receipts: operations.map((item) => ({ id: item.SK.slice(2), receipt: item.receipt })),
        };
      } catch {
        throw unavailable();
      }
    },
    retireReceipts(request) {
      return writeOperation(request, () =>
        Promise.all(
          request.receipts.map(async (item) => {
            const target = retainedOperationKey(item.id);
            assertStore(target !== operationKey(request.operationId), 'A deletion operation cannot retire itself.');
            const old = (await getItem(target))?.receipt;
            const receipt = retireReceipt(old, item, request);
            return {
              Put: {
                TableName: config.table,
                Item: { ...key(target), receipt },
                ConditionExpression: '#receipt = :receipt',
                ExpressionAttributeNames: { '#receipt': 'receipt' },
                ExpressionAttributeValues: { ':receipt': old },
              },
            };
          })
        )
      );
    },
    async get(value) {
      try {
        return row(await getItem(recordKey(value)));
      } catch {
        throw unavailable();
      }
    },
    async list(prefix) {
      try {
        return (await query(recordKey(prefix))).map(row);
      } catch {
        throw unavailable();
      }
    },
    commit(request) {
      return writeOperation(request, () => {
        const writes = new Map(request.writes.map((write) => [write.key, write.record]));
        return request.expected.map((expected) => transactionChange(expected, writes, key, config.table));
      });
    },
    close() {
      client.destroy();
    },
  };
}
