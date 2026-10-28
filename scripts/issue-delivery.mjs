import { prepareDraftHandoff, requireDraftHandoff, draftHandoffBody } from './issue-draft-handoff.mjs';
import { deliveryMode, draftHandoff } from './factory-ui/delivery-mode.mjs';
import { checkHandoff } from './factory-ui/handoff-checks.mjs';
import { assembleExisting } from './issue-delivery-assembly.mjs';
import { linkDeliveryDependencies } from './issue-delivery-dependencies.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { factory } from './factory-ledger.mjs';
import { readQueue } from './factory-ui/data.mjs';
import { humanGuard } from './factory-ui/guard.mjs';
import { checkCandidate } from './factory-ui/checks.mjs';
import { digest, git, readJson, requireThat } from './factory-ui/common.mjs';
import { DeliveryStore, evidence } from './issue-delivery-store.mjs';
import {
  approvedPlan,
  candidateUnchanged,
  checkedEvidence,
  completionManifest,
  currentContributions,
  issueBasis,
  requireMergeObservation,
} from './issue-delivery-policy.mjs';
import { GitHubDeliveryProvider } from './issue-delivery-provider.mjs';

export class IssueDelivery {
  constructor(root, options = {}) {
    this.root = root;
    this.provider = options.provider || new GitHubDeliveryProvider(root);
    this.check = options.check || checkCandidate;
    this.guard = options.guard || humanGuard;
  }
  inspect(issueId) {
    return new DeliveryStore(this.root, issueId).read();
  }
  context(issueId) {
    const queue = readQueue(this.root),
      issue = queue.issues.find((i) => i.id === issueId);
    requireThat(issue, 'Select an existing issue.');
    const configPath = join(this.root, '.issues/issue-delivery-config.json');
    requireThat(
      existsSync(configPath),
      'Pull request settings are missing. Choose a target branch in this issue to save them and continue.'
    );
    const config = readJson(configPath);
    requireThat(
      config.provider === 'github' && /^[\w.-]+\/[\w.-]+$/.test(config.repository),
      'Configure an explicit GitHub repository.'
    );
    requireThat(
      config.remote === 'origin' && /^[\w/.-]+$/.test(config.target),
      'Configure origin and an explicit target branch.'
    );
    const url = git(this.root, 'remote', 'get-url', config.remote);
    requireThat(
      [`https://github.com/${config.repository}.git`, `git@github.com:${config.repository}.git`].includes(url),
      'The configured remote repository identity changed.'
    );
    const plan = approvedPlan(this.root, issueId);
    return { queue, issue, config, plan, basis: issueBasis(queue, issue, config, plan) };
  }
  async operate(kind, input) {
    requireThat(
      ['assemble', 'handoff', 'ready', 'open', 'refresh', 'merge', 'reconcile', 'verify'].includes(kind),
      'Unknown issue delivery operation.'
    );
    const store = new DeliveryStore(this.root, input.issueId);
    return store.locked(async () => {
      const context = this.context(input.issueId);
      if (kind === 'merge') return store.targetLocked(() => this.merge(store, context, input));
      return this[kind](store, context, input);
    });
  }
  create(store, context, action) {
    const { config, issue, plan } = context;
    const checkout = join(store.directory, 'checkout'),
      source = 'factory/issue-' + issue.id;
    requireThat(!existsSync(checkout), 'Reconcile the existing assembly checkout before continuing.');
    git(this.root, 'worktree', 'add', '-b', source, checkout, action.start?.revision || action.basis.head);
    return store.save({
      version: 1,
      mode: deliveryMode(context.queue, issue),
      issueId: issue.id,
      repository: config.repository,
      remote: config.remote,
      target: config.target,
      source,
      checkout,
      originalBase: action.start?.revision || action.basis.head,
      targetRevision: action.start?.revision || action.basis.head,
      candidate: action.start?.revision || action.basis.head,
      tree: git(checkout, 'rev-parse', 'HEAD^{tree}'),
      generation: 0,
      state: 'collecting',
      plan: plan.sha256,
      contributions: [],
    });
  }
  async assemble(store, context, input) {
    const action = context.queue.actions.find((a) => a.id === input.actionId);
    requireThat(
      action && ['completed', 'assembled'].includes(action.status) && ['implement', 'integrate'].includes(action.kind),
      'Assemble independently reviewed completed code work.'
    );
    requireThat(
      action.issues.length === 1 && action.issues[0] === input.issueId,
      'Grouped work needs separately authorized scoped allocations; a whole candidate cannot enter multiple issue PRs.'
    );
    requireThat(action.merge !== 'none', 'Preserve the contribution merge policy.');
    const delivery = store.read() || this.create(store, context, action);
    requireThat(!delivery.pr, 'An open issue PR needs an explicit revision plan before further contributions.');
    const recorded = delivery.contributions.find((c) => c.actionId === action.id);
    if (recorded) {
      this.recordAssembly(action, recorded, store);
      return delivery;
    }
    requireThat(
      delivery.candidate === input.expectedCandidate,
      'The issue branch advanced; review its current candidate.'
    );
    evidence(input.review);
    if (delivery.mode !== draftHandoff) this.guard(this.root, action, 'merge', delivery.candidate);
    const intent = {
      actionId: action.id,
      before: delivery.candidate,
      workerRevision: action.worker_revision,
      originalBase: action.start?.revision || action.basis.head,
      merge: action.merge,
      issues: action.issues,
      authorization: action.authorization,
      review: input.review,
      findings: action.evidence || '',
    };
    store.retain('assembly-' + action.id + '-intent', intent);
    assembleExisting(store, delivery, intent);
    linkDeliveryDependencies(this.root, delivery.checkout);
    const checks =
      delivery.mode === draftHandoff
        ? await this.handoffChecks(delivery, store, action)
        : await this.checkBases(
            delivery.checkout,
            [delivery.originalBase, intent.originalBase],
            join(store.directory, 'checks-' + action.id)
          );
    const checked = checks.checked;
    requireThat(checked.head === git(delivery.checkout, 'rev-parse', 'HEAD'), 'The checked assembly changed.');
    const current = this.context(input.issueId);
    requireThat(
      current.basis === context.basis &&
        JSON.stringify(current.queue.actions.find((a) => a.id === action.id)) === JSON.stringify(action),
      'Issue or action changed during assembly checks.'
    );
    const contribution = {
      ...intent,
      candidate: checked.head,
      tree: checked.tree,
      evidence: [input.review, ...checks.evidence],
      ...(delivery.mode === draftHandoff ? { handoffCheck: checked } : {}),
    };
    const receipt = store.retain('assembly-' + action.id, contribution);
    contribution.receipt = receipt;
    store.save({
      ...delivery,
      candidate: checked.head,
      tree: checked.tree,
      generation: delivery.generation + 1,
      state: 'collecting',
      readiness: null,
      contributions: [...delivery.contributions, contribution],
    });
    this.recordAssembly(action, contribution, store);
    return store.read();
  }
  recordAssembly(action, contribution, store) {
    if (action.status === 'assembled') return;
    factory(this.root).record(action.id, {
      status: 'assembled',
      evidence: 'Issue-branch contribution retained; check results are recorded separately: ' + store.path,
      assembly: contribution.receipt,
    });
  }
  handoff(store, context) {
    return prepareDraftHandoff(this, store, context);
  }
  async handoffChecks(delivery, store, action) {
    let worker;
    try {
      worker = JSON.parse(action.evidence.split(' Independent checks: ')[0]).handoffChecks;
    } catch {}
    if (worker?.head === git(delivery.checkout, 'rev-parse', 'HEAD') && worker.base === delivery.originalBase) {
      worker.evidence.forEach((entry) => evidence(entry));
      return { checked: worker, evidence: worker.evidence };
    }
    const checked = await checkHandoff(
      this.check,
      delivery.checkout,
      delivery.originalBase,
      join(store.directory, 'checks-' + action.id)
    );
    return { checked, evidence: checked.evidence };
  }
  ready(store, context, input) {
    const delivery = store.read();
    requireThat(delivery && !delivery.pr, 'Collect the issue contributions before completion review.');
    requireThat(
      deliveryMode(context.queue, context.issue, undefined, delivery.mode) !== draftHandoff,
      'Use handoff to prepare this draft PR; verified completion is a separate route.'
    );
    candidateUnchanged(delivery);
    currentContributions(context.queue, delivery);
    this.guard(
      this.root,
      { id: input.issueId, issues: [input.issueId], worker_revision: delivery.candidate },
      'verify',
      delivery.candidate
    );
    const retained = completionManifest(context.queue, context.issue, delivery, input.manifest, context.plan);
    const manifest = store.retain(
      'completion-' + delivery.generation + '-' + digest(JSON.stringify(input.manifest)),
      input.manifest
    );
    return store.save({
      ...delivery,
      state: 'ready',
      mode: 'verified-delivery',
      readiness: { basis: context.basis, evidence: [...retained, manifest], manifest: input.manifest },
    });
  }
  requireReady(context, delivery) {
    if (delivery?.mode)
      requireThat(
        deliveryMode(context.queue, context.issue, undefined, delivery.mode) === delivery.mode,
        'The selected delivery route changed. Prepare the current route.'
      );
    if (delivery?.readiness?.kind === draftHandoff) return requireDraftHandoff(context, delivery);
    requireThat(
      delivery?.readiness && delivery.readiness.basis === context.basis,
      'Issue completion evidence is missing or stale.'
    );
    candidateUnchanged(delivery);
    currentContributions(context.queue, delivery);
    delivery.readiness.evidence.forEach(evidence);
    completionManifest(context.queue, context.issue, delivery, delivery.readiness.manifest, context.plan);
  }
  async open(store, context) {
    const delivery = store.read();
    this.requireReady(context, delivery);
    if (delivery.pr) return this.refresh(store, context);
    const request = this.request(delivery);
    for (const contribution of delivery.mode === draftHandoff ? [] : delivery.contributions)
      this.guard(
        this.root,
        { id: contribution.actionId, issues: contribution.issues, worker_revision: delivery.candidate },
        'merge',
        delivery.targetRevision
      );
    store.save({ ...delivery, state: 'opening' });
    await store.effect(
      'publish',
      request,
      () => this.provider.findBranch(request),
      () => this.provider.publish(request, delivery.checkout)
    );
    const pr = await store.effect(
      'open',
      request,
      () => this.provider.findPullRequests(request),
      () => this.provider.open(request, context.issue.title || delivery.issueId)
    );
    requireThat(
      pr.state === 'open' &&
        pr.repository === delivery.repository &&
        pr.source === delivery.source &&
        pr.target === delivery.target,
      'The discovered PR is closed or has a different identity.'
    );
    return store.save({ ...delivery, state: delivery.mode === draftHandoff ? 'handed-off' : 'open', pr });
  }
  request(delivery) {
    return {
      ...(delivery.mode === draftHandoff
        ? {
            mode: draftHandoff,
            draft: true,
            body: delivery.readiness?.report ? draftHandoffBody(delivery.readiness.report) : '',
          }
        : {}),
      repository: delivery.repository,
      remote: delivery.remote,
      issueId: delivery.issueId,
      source: delivery.source,
      target: delivery.target,
      candidate: delivery.candidate,
      targetRevision: delivery.targetRevision,
      generation: delivery.generation,
      plan: delivery.plan,
      contributions: delivery.contributions.map((c) => c.actionId),
    };
  }
  async refresh(store, context) {
    const delivery = store.read();
    requireThat(delivery?.pr, 'Open the complete issue PR first.');
    const observation = await this.provider.observe(this.request(delivery), delivery.pr);
    const receipt = store.retain('observation-' + digest(JSON.stringify(observation)), observation);
    return store.save({ ...delivery, observation, observationEvidence: receipt });
  }
  async merge(store, context, input) {
    const delivery = store.read();
    requireThat(delivery?.mode !== draftHandoff, 'This draft PR was handed off for manual repair and merge.');
    this.requireReady(context, delivery);
    requireThat(delivery.pr && !delivery.merge, 'Reconcile an already merged result instead of merging again.');
    const request = this.request(delivery);
    const fresh = await this.refresh(store, context);
    requireMergeObservation(delivery, fresh.observation);
    for (const c of delivery.contributions)
      this.guard(
        this.root,
        { id: c.actionId, issues: c.issues, worker_revision: delivery.candidate },
        'merge',
        delivery.targetRevision
      );
    if (delivery.contributions.some((c) => c.merge === 'human-first'))
      this.requireApproval(store, delivery, input.approval);
    const current = this.context(delivery.issueId);
    this.requireReady(current, delivery);
    requireThat(current.basis === context.basis, 'The issue changed during merge preflight.');
    const authority = store.retain('merge-authority-' + delivery.generation, {
      request,
      observation: fresh.observationEvidence,
      approval: input.approval || null,
    });
    store.save({ ...fresh, state: 'merging', mergeAuthority: authority });
    const result = await store.effect(
      'merge',
      request,
      () => this.provider.findMerge(request, delivery.pr),
      () => this.provider.merge(request, delivery.pr)
    );
    return store.save({ ...fresh, state: 'merged-unverified', merge: result, mergeAuthority: authority });
  }
  requireApproval(store, delivery, approval) {
    evidence(approval);
    const value = readJson(approval.path);
    requireThat(
      value.actor === 'human' &&
        value.operation === 'merge-issue-pr' &&
        value.issueId === delivery.issueId &&
        value.fingerprint === digest(JSON.stringify(this.request(delivery))),
      'Human-first approval must cover the exact aggregate candidate, target and all contributions.'
    );
    store.retain('approval-' + delivery.generation, { approval, value });
  }
  async reconcile(store, context) {
    const delivery = store.read();
    requireThat(delivery, 'There is no saved delivery to reconcile.');
    if (!delivery.pr) return this.open(store, context);
    if (delivery.mode === draftHandoff) return delivery;
    const found = await this.provider.findMerge(this.request(delivery), delivery.pr);
    requireThat(found.length <= 1, 'Ambiguous merge identity; preserve the operation.');
    if (found.length) {
      requireThat(found[0].prId === delivery.pr.id, 'Merged PR identity changed.');
      return store.save({ ...delivery, state: 'merged-unverified', merge: found[0] });
    }
    requireThat(delivery.state !== 'merging', 'Uncertain merge outcome; do not retry the merge.');
    return this.refresh(store, context);
  }
  async verify(store, context) {
    const delivery = store.read();
    requireThat(delivery?.mode !== draftHandoff, 'This draft PR is owned by the manual workflow.');
    if (delivery?.state === 'verified') {
      evidence(delivery.integration);
      readJson(delivery.integration.path).evidence.forEach(evidence);
      this.recordIntegrations(delivery);
      return delivery;
    }
    requireThat(delivery?.merge, 'Reconcile the confirmed remote merge before verifying integration.');
    requireThat(
      delivery.merge.prId === delivery.pr.id && delivery.merge.tree === delivery.tree,
      'The remote merged result differs from the tested issue tree. Reconcile before integration.'
    );
    evidence(delivery.mergeAuthority);
    const authority = readJson(delivery.mergeAuthority.path);
    requireThat(
      digest(JSON.stringify(authority.request)) === digest(JSON.stringify(this.request(delivery))),
      'The merge authority tuple changed.'
    );
    evidence(authority.observation);
    requireMergeObservation(delivery, readJson(authority.observation.path));
    if (delivery.contributions.some((c) => c.merge === 'human-first'))
      this.requireApproval(store, delivery, authority.approval);
    delivery.readiness.evidence.forEach(evidence);
    currentContributions(context.queue, delivery);
    const checkout = join(store.directory, 'integrated');
    await this.provider.fetchMerge(this.request(delivery), delivery.merge, this.root);
    if (!existsSync(checkout)) git(this.root, 'worktree', 'add', '--detach', checkout, delivery.merge.revision);
    requireThat(
      git(checkout, 'rev-parse', 'HEAD') === delivery.merge.revision &&
        git(checkout, 'rev-parse', 'HEAD^{tree}') === delivery.merge.tree,
      'Merged source identity changed.'
    );
    linkDeliveryDependencies(this.root, checkout);
    const checks = await this.checkBases(
      checkout,
      [delivery.originalBase, ...delivery.contributions.map((c) => c.originalBase)],
      join(store.directory, 'integration-checks')
    );
    const retained = checks.evidence;
    const receipt = store.retain('integration-' + delivery.generation, {
      issueId: delivery.issueId,
      pr: delivery.pr,
      merge: delivery.merge,
      contributions: delivery.contributions.map((c) => c.actionId),
      evidence: retained,
    });
    currentContributions(this.context(delivery.issueId).queue, delivery);
    for (const c of delivery.contributions)
      this.guard(
        this.root,
        { id: c.actionId, issues: c.issues, worker_revision: delivery.candidate },
        'record-integration',
        delivery.merge.revision
      );
    const verified = store.save({ ...delivery, state: 'verified', integration: receipt });
    this.recordIntegrations(delivery, receipt);
    return verified;
  }
  async checkBases(checkout, bases, folder) {
    let checked;
    const retained = [];
    for (const base of new Set(bases)) {
      checked = await this.check(checkout, base, join(folder, base));
      requireThat(checked.head === git(checkout, 'rev-parse', 'HEAD'), 'The checked delivery changed.');
      retained.push(...checkedEvidence(checked.summaries, base, checked.tree));
    }
    return { checked, evidence: retained };
  }
  recordIntegrations(delivery, receipt = delivery.integration) {
    for (const contribution of delivery.contributions) {
      const action = readQueue(this.root).actions.find((a) => a.id === contribution.actionId);
      if (action.status === 'integrated') continue;
      this.guard(this.root, action, 'record-integration', delivery.merge.revision);
      factory(this.root).record(action.id, {
        status: 'integrated',
        verified_revision: delivery.merge.revision,
        evidence: 'Independently verified issue PR integration: ' + receipt.path,
      });
    }
  }
}
