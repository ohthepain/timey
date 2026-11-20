import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, requireThat } from './common.mjs';

export function sharedIssueQueueEnabled(root) {
  const path = join(root, 'factory.config.json');
  return existsSync(path) && readJson(path).sharedIssueQueue === true;
}

function sharedIssueQueueBranch(root, deliveryBranch) {
  const { sharedIssueQueueBranch: branch } = readJson(join(root, 'factory.config.json'));
  if (branch === undefined) return undefined;
  requireThat(typeof branch === 'string', 'Use a Git branch name for the shared issue queue.');
  requireThat(
    /^(?!(?:claims|queue-updates)\/)[a-zA-Z0-9][\w./-]*$/.test(branch) && branch !== deliveryBranch,
    'Use a dedicated shared issue queue branch outside the delivery and claim branches.'
  );
  return branch;
}

export function queueReportPaths(exclude = false) {
  const prefix = exclude ? ':(glob,exclude)' : ':(glob)';
  return ['.issues/[0-9]*.md', '.issues/closed/[0-9]*.md', '.issues/issue-numbers.json'].map((path) => prefix + path);
}

export function sharedIssueQueueConfig(root) {
  if (!sharedIssueQueueEnabled(root)) return null;
  const path = join(root, '.issues/issue-delivery-config.json');
  requireThat(existsSync(path), 'Configure GitHub issue delivery before enabling the shared queue.');
  const config = readJson(path);
  validateDeliveryConfig(config);
  const branch = sharedIssueQueueBranch(root, config.target);
  return {
    ...config,
    target: branch ?? config.target,
    separateBranch: branch,
    direct: directPublication(root, branch),
    requireReview: reviewRequired(root, branch),
  };
}

function directPublication(root, branch) {
  const { sharedIssueQueueDirect: direct = false } = readJson(join(root, 'factory.config.json'));
  requireThat(typeof direct === 'boolean', 'Set sharedIssueQueueDirect to true or false.');
  requireThat(!direct || branch, 'Direct publishing requires a dedicated queue branch.');
  return direct;
}

function reviewRequired(root, branch) {
  const { sharedIssueQueueReviewRequired: required = true } = readJson(join(root, 'factory.config.json'));
  requireThat(typeof required === 'boolean', 'Set sharedIssueQueueReviewRequired to true or false.');
  requireThat(required || branch, 'A queue without required reviews needs a dedicated queue branch.');
  return required;
}

function validateDeliveryConfig(config) {
  const names = [
    [config.repository, /^[\w.-]+\/[\w.-]+$/],
    [config.remote, /^[a-zA-Z0-9][\w.-]*$/],
    [config.target, /^[a-zA-Z0-9][\w./-]*$/],
  ];
  requireThat(
    config.provider === 'github' && names.every(([value, pattern]) => typeof value === 'string' && pattern.test(value)),
    'The shared queue requires a configured GitHub repository, remote and target branch.'
  );
}
